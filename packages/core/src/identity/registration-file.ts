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

	const hasA2AEndpoint = obj.services.some(
		(s: unknown) =>
			typeof s === "object" &&
			s !== null &&
			typeof (s as Record<string, unknown>).name === "string" &&
			typeof (s as Record<string, unknown>).endpoint === "string" &&
			(s as Record<string, unknown>).name === "a2a",
	);

	if (!hasA2AEndpoint) {
		throw new IdentityError("Registration file must have at least one service with name 'a2a'");
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
