import { IdentityError, isEthereumAddress } from "../common/index.js";
import type { RegistrationFile } from "./types.js";

export function validateRegistrationFile(data: unknown): RegistrationFile {
	if (typeof data !== "object" || data === null) {
		throw new IdentityError("Registration file must be a JSON object");
	}

	const obj = data as Record<string, unknown>;

	if (obj.type !== "eip-8004-registration-v1") {
		throw new IdentityError(
			`Invalid registration file type: ${String(obj.type)}. Expected "eip-8004-registration-v1"`,
		);
	}

	if (typeof obj.name !== "string" || obj.name.length === 0) {
		throw new IdentityError("Registration file must have a non-empty name");
	}

	if (typeof obj.description !== "string") {
		throw new IdentityError("Registration file must have a description");
	}

	if (!Array.isArray(obj.services) || obj.services.length === 0) {
		throw new IdentityError("Registration file must have at least one service");
	}

	const hasXmtpService = obj.services.some(
		(s: unknown) =>
			typeof s === "object" &&
			s !== null &&
			(s as Record<string, unknown>).name === "xmtp" &&
			typeof (s as Record<string, unknown>).endpoint === "string",
	);

	if (!hasXmtpService) {
		throw new IdentityError("Registration file must have an 'xmtp' transport service");
	}

	for (const service of obj.services) {
		if (typeof service !== "object" || service === null) {
			throw new IdentityError("Each service must be an object");
		}
		const svc = service as Record<string, unknown>;
		if (typeof svc.name !== "string" || svc.name.length === 0) {
			throw new IdentityError("Each service must have a non-empty name");
		}
		if (typeof svc.endpoint !== "string" || svc.endpoint.length === 0) {
			throw new IdentityError("Each service must have a non-empty endpoint");
		}
		if (svc.name === "xmtp") {
			if (!isEthereumAddress(svc.endpoint)) {
				throw new IdentityError(
					`XMTP service endpoint must be a valid Ethereum address: ${String(svc.endpoint)}`,
				);
			}
		} else {
			let endpointUrl: URL;
			try {
				endpointUrl = new URL(svc.endpoint);
			} catch {
				throw new IdentityError(`Invalid service endpoint URL: ${String(svc.endpoint)}`);
			}
			if (endpointUrl.protocol !== "https:") {
				throw new IdentityError(`Service endpoint must use https: ${String(svc.endpoint)}`);
			}
		}
	}

	if (typeof obj.trustedAgentProtocol !== "object" || obj.trustedAgentProtocol === null) {
		throw new IdentityError("Registration file must have a trustedAgentProtocol section");
	}

	const tap = obj.trustedAgentProtocol as Record<string, unknown>;

	if (typeof tap.version !== "string" || tap.version.length === 0) {
		throw new IdentityError("trustedAgentProtocol must have a non-empty version");
	}

	if (typeof tap.agentAddress !== "string" || !isEthereumAddress(tap.agentAddress)) {
		throw new IdentityError("trustedAgentProtocol must have a valid agentAddress");
	}

	if (!Array.isArray(tap.capabilities)) {
		throw new IdentityError("trustedAgentProtocol must have a capabilities array");
	}

	if (tap.execution !== undefined) {
		if (typeof tap.execution !== "object" || tap.execution === null) {
			throw new IdentityError("trustedAgentProtocol.execution must be an object");
		}

		const execution = tap.execution as Record<string, unknown>;
		if (execution.mode !== "eoa" && execution.mode !== "eip4337" && execution.mode !== "eip7702") {
			throw new IdentityError(
				"trustedAgentProtocol.execution.mode must be eoa, eip4337, or eip7702",
			);
		}

		if (typeof execution.address !== "string" || !isEthereumAddress(execution.address)) {
			throw new IdentityError(
				"trustedAgentProtocol.execution.address must be a valid Ethereum address",
			);
		}

		if (
			execution.paymaster !== undefined &&
			(typeof execution.paymaster !== "string" || execution.paymaster.length === 0)
		) {
			throw new IdentityError(
				"trustedAgentProtocol.execution.paymaster must be a non-empty string",
			);
		}
	}

	const xmtpService = obj.services.find(
		(service) =>
			typeof service === "object" &&
			service !== null &&
			(service as Record<string, unknown>).name === "xmtp",
	) as Record<string, unknown> | undefined;

	if (xmtpService) {
		const xmtpEndpoint = String(xmtpService.endpoint).toLowerCase();
		if (xmtpEndpoint !== tap.agentAddress.toLowerCase()) {
			throw new IdentityError("XMTP service endpoint must match trustedAgentProtocol.agentAddress");
		}
	}

	return data as RegistrationFile;
}

export async function fetchRegistrationFile(uri: string): Promise<RegistrationFile> {
	const resolvedUri = resolveRegistrationUri(uri);
	if (!isSafeRemoteUri(resolvedUri)) {
		throw new IdentityError(`Registration URI is not allowed: ${resolvedUri}`);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);

	try {
		const response = await fetch(resolvedUri, { signal: controller.signal });
		if (!response.ok) {
			throw new IdentityError(
				`Failed to fetch registration file from ${resolvedUri}: HTTP ${response.status}`,
			);
		}
		const data = await response.json();
		return validateRegistrationFile(data);
	} catch (error) {
		if (error instanceof IdentityError) throw error;
		throw new IdentityError(
			`Failed to fetch registration file from ${resolvedUri}: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timeout);
	}
}

function resolveRegistrationUri(uri: string): string {
	if (uri.startsWith("ipfs://")) {
		const cidAndPath = uri.slice("ipfs://".length);
		if (!cidAndPath) {
			throw new IdentityError("Invalid ipfs:// registration URI");
		}
		return `https://ipfs.io/ipfs/${cidAndPath}`;
	}

	const parsed = new URL(uri);
	if (parsed.protocol !== "https:") {
		throw new IdentityError(`Unsupported registration URI protocol: ${parsed.protocol}`);
	}
	return parsed.toString();
}

function isSafeRemoteUri(uri: string): boolean {
	const url = new URL(uri);
	const host = url.hostname.toLowerCase();

	if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
		return false;
	}
	if (/^127\./.test(host)) return false;
	if (/^10\./.test(host)) return false;
	if (/^192\.168\./.test(host)) return false;
	if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;

	return true;
}
