import type {
	ExecutionPreview,
	IpfsUploadProvider,
	TrustedAgentsConfig,
} from "trusted-agents-core";
import { createExecutionEvmSigner } from "trusted-agents-core";

const PINATA_X402_ENDPOINT = "https://402.pinata.cloud/v1/pin/public";
const PINATA_API_ENDPOINT = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
export const DEFAULT_TACK_API_ENDPOINT = "https://tack-api-production.up.railway.app";

const IPFS_UPLOAD_PROVIDERS = ["auto", "x402", "pinata", "tack"] as const;

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

const TAIKO_CHAINS = new Set(["eip155:167000", "eip155:167013"]);

export function resolveIpfsUploadProvider(value?: string): IpfsUploadProvider | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}

	if ((IPFS_UPLOAD_PROVIDERS as readonly string[]).includes(normalized)) {
		return normalized as IpfsUploadProvider;
	}

	throw new Error(
		`Invalid IPFS provider: ${value}. Expected one of: ${IPFS_UPLOAD_PROVIDERS.join(", ")}`,
	);
}

/**
 * Resolve `auto` to a concrete provider based on chain and available credentials.
 *
 * Priority: chain-specific provider first, then explicit credentials, then default.
 * 1. Taiko chains → `tack` (x402 on Taiko — chain always wins)
 * 2. Pinata JWT present → `pinata` (explicit credential for non-Taiko chains)
 * 3. Otherwise → `x402` (Pinata x402 on Base)
 */
export function resolveAutoProvider(
	chain: string,
	pinataJwt?: string,
): Exclude<IpfsUploadProvider, "auto"> {
	if (TAIKO_CHAINS.has(chain)) return "tack";
	if (pinataJwt) return "pinata";
	return "x402";
}

export function resolveEffectiveIpfsProvider(params: {
	chain: string;
	configuredProvider?: string;
	pinataJwt?: string;
}): Exclude<IpfsUploadProvider, "auto"> {
	const provider = resolveIpfsUploadProvider(params.configuredProvider) ?? "auto";
	return provider === "auto" ? resolveAutoProvider(params.chain, params.pinataJwt) : provider;
}

export function resolveTackApiUrl(configValue?: string): string {
	const envValue = process.env.TAP_TACK_API_URL;
	const url = trimTrailingSlash(envValue?.trim() || configValue || DEFAULT_TACK_API_ENDPOINT);

	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new Error("invalid protocol");
		}
	} catch {
		throw new Error(`Invalid Tack API URL: ${url}`);
	}

	return url;
}

/**
 * Upload JSON to IPFS via Pinata's x402 endpoint.
 *
 * Pays with USDC on Base mainnet — no Pinata account or API key needed.
 * The agent's wallet must have USDC on Base mainnet even if it's registered
 * on a different chain (e.g. Base Sepolia).
 *
 * Uses @x402/fetch + @x402/evm to handle x402 v2 payment automatically:
 *   1. POST fileSize to 402.pinata.cloud → 402
 *   2. wrapFetchWithPayment handles header parsing, signing, and retry
 *   3. Upload file to presigned URL → file is pinned on IPFS
 */
export async function uploadToIpfsX402(
	json: unknown,
	privateKey: `0x${string}`,
): Promise<{ cid: string; uri: string }> {
	const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
	const { ExactEvmScheme } = await import("@x402/evm/exact/client");
	const { toClientEvmSigner } = await import("@x402/evm");
	const { privateKeyToAccount } = await import("viem/accounts");
	const { createPublicClient, http } = await import("viem");
	const { base } = await import("viem/chains");

	// Create signer for Base mainnet (x402 payment always uses Base mainnet USDC)
	const account = privateKeyToAccount(privateKey);
	const publicClient = createPublicClient({ chain: base, transport: http() });
	const signer = toClientEvmSigner(account, publicClient);

	const client = new x402Client();
	client.register("eip155:*", new ExactEvmScheme(signer));

	const fetchWithPayment = wrapFetchWithPayment(fetch, client);

	const content = JSON.stringify(json);
	const fileSize = Buffer.byteLength(content, "utf-8");

	// Step 1+2: Request pin → 402 → auto-pay → presigned URL
	const pinUrl = `${PINATA_X402_ENDPOINT}?fileSize=${fileSize}`;
	const paidResponse = await fetchWithPayment(pinUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});

	if (!paidResponse.ok) {
		const text = await paidResponse.text().catch(() => "");
		throw new Error(`x402 pin request failed (HTTP ${paidResponse.status}): ${text}`);
	}

	const pinResponse = (await paidResponse.json()) as { url: string; cid?: string };
	if (!pinResponse.url) {
		throw new Error("x402 pin response missing presigned upload URL");
	}

	// Step 3: Upload file to presigned URL
	const blob = new Blob([content], { type: "application/json" });
	const formData = new FormData();
	formData.append("file", blob, "registration.json");

	const uploadResponse = await fetch(pinResponse.url, {
		method: "POST",
		body: formData,
	});

	if (!uploadResponse.ok) {
		const text = await uploadResponse.text().catch(() => "");
		throw new Error(`File upload failed (HTTP ${uploadResponse.status}): ${text}`);
	}

	const uploadResult = (await uploadResponse.json()) as {
		IpfsHash?: string;
		cid?: string;
		data?: { cid?: string };
	};
	const cid =
		pinResponse.cid ?? uploadResult.data?.cid ?? uploadResult.IpfsHash ?? uploadResult.cid;

	if (!cid) {
		throw new Error("Could not determine IPFS CID from upload response");
	}

	return { cid, uri: `ipfs://${cid}` };
}

/**
 * Upload JSON to IPFS through Tack's x402 `/upload` endpoint.
 *
 * Pays with USDC on Taiko Alethia (eip155:167000).
 * Uses the resolved execution account as the x402 payer, so Taiko/Servo can
 * pay from the smart account even before first deployment.
 */
export async function uploadToIpfsTack(
	json: unknown,
	config: TrustedAgentsConfig,
	options?: {
		apiUrl?: string;
		preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode">;
	},
): Promise<{ cid: string; uri: string }> {
	const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
	const { ExactEvmScheme } = await import("@x402/evm/exact/client");
	const chainConfig = config.chains[config.chain];
	if (!chainConfig) {
		throw new Error(`No chain config for ${config.chain}`);
	}
	const signer = await createExecutionEvmSigner(config, chainConfig, {
		preview: options?.preview,
	});

	const client = new x402Client();
	client.register("eip155:*", new ExactEvmScheme(signer));
	const fetchWithPayment = wrapFetchWithPayment(fetch, client);

	const content = JSON.stringify(json);
	const blob = new Blob([content], { type: "application/json" });
	const formData = new FormData();
	formData.append("file", blob, "registration.json");

	const apiUrl = trimTrailingSlash(options?.apiUrl ?? resolveTackApiUrl());
	const response = await fetchWithPayment(`${apiUrl}/upload`, {
		method: "POST",
		body: formData,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Tack upload failed (HTTP ${response.status}): ${text}`);
	}

	const result = (await response.json()) as {
		cid?: string;
		IpfsHash?: string;
		data?: { cid?: string };
	};
	const cid = result.cid ?? result.IpfsHash ?? result.data?.cid;
	if (!cid) {
		throw new Error("Tack response missing cid");
	}

	return { cid, uri: `ipfs://${cid}` };
}

/**
 * Upload JSON to IPFS via Pinata's authenticated API.
 *
 * Requires a Pinata JWT token, provided via:
 *   1. --pinata-jwt flag
 *   2. TAP_PINATA_JWT env var
 */
export async function uploadToIpfsPinata(
	json: unknown,
	pinataJwt: string,
	name?: string,
): Promise<{ cid: string; uri: string }> {
	const body = JSON.stringify({
		pinataContent: json,
		pinataMetadata: { name: name ?? "tap-registration" },
	});

	const response = await fetch(PINATA_API_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${pinataJwt}`,
		},
		body,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Pinata upload failed (HTTP ${response.status}): ${text}`);
	}

	const result = (await response.json()) as { IpfsHash: string };
	if (!result.IpfsHash) {
		throw new Error("Pinata response missing IpfsHash");
	}

	return {
		cid: result.IpfsHash,
		uri: `ipfs://${result.IpfsHash}`,
	};
}

export function resolvePinataJwt(flagValue?: string): string | undefined {
	return flagValue ?? (process.env.TAP_PINATA_JWT || undefined);
}
