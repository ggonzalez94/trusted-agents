const PINATA_X402_ENDPOINT = "https://402.pinata.cloud/v1/pin/public";
const PINATA_API_ENDPOINT = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

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
	const cid = pinResponse.cid ?? uploadResult.data?.cid ?? uploadResult.IpfsHash ?? uploadResult.cid;

	if (!cid) {
		throw new Error("Could not determine IPFS CID from upload response");
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
	return flagValue ?? process.env["TAP_PINATA_JWT"];
}
