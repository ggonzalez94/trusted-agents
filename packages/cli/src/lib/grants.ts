import { readFile } from "node:fs/promises";
import {
	type ContactPermissionState,
	type PermissionGrant,
	type PermissionGrantSet,
	TAP_GRANTS_VERSION,
	ValidationError,
	createGrantSet,
} from "trusted-agents-core";

export interface ConnectionPermissionIntentInput {
	requestedGrants?: PermissionGrantSet;
	offeredGrants?: PermissionGrantSet;
}

export async function readGrantFile(path: string): Promise<PermissionGrantSet> {
	const raw = await readFile(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ValidationError(
			`Invalid grant file JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return normalizeGrantInput(parsed);
}

export function normalizeGrantInput(input: unknown): PermissionGrantSet {
	if (Array.isArray(input)) {
		return createGrantSet(input.map(normalizeGrantLike));
	}

	if (typeof input !== "object" || input === null) {
		throw new ValidationError("Grant input must be a JSON object or array");
	}

	const data = input as { grants?: unknown; version?: unknown };
	if (!Array.isArray(data.grants)) {
		throw new ValidationError('Grant object must include a "grants" array');
	}

	const grantSet = createGrantSet(data.grants.map(normalizeGrantLike));
	if (data.version !== undefined && data.version !== TAP_GRANTS_VERSION) {
		throw new ValidationError(
			`Unsupported grant set version: ${String(data.version)}. Expected ${TAP_GRANTS_VERSION}`,
		);
	}
	return grantSet;
}

export function summarizeGrant(grant: PermissionGrant): string {
	const status = grant.status === "revoked" ? "revoked" : "active";
	const constraints =
		grant.constraints && Object.keys(grant.constraints).length > 0
			? ` ${JSON.stringify(grant.constraints)}`
			: "";
	return `${grant.grantId}: ${grant.scope} [${status}]${constraints}`;
}

export function summarizeGrantSet(grantSet: PermissionGrantSet | undefined): string[] {
	if (!grantSet || grantSet.grants.length === 0) {
		return ["(none)"];
	}

	return grantSet.grants.map(summarizeGrant);
}

export function buildPermissionState(params?: {
	grantedByMe?: PermissionGrantSet;
	grantedByPeer?: PermissionGrantSet;
}): ContactPermissionState {
	return {
		grantedByMe: params?.grantedByMe ?? createGrantSet([]),
		grantedByPeer: params?.grantedByPeer ?? createGrantSet([]),
	};
}

export function replaceGrantedByMe(
	state: ContactPermissionState,
	grantSet: PermissionGrantSet,
): ContactPermissionState {
	return {
		grantedByMe: grantSet,
		grantedByPeer: state.grantedByPeer,
	};
}

export function replaceGrantedByPeer(
	state: ContactPermissionState,
	grantSet: PermissionGrantSet,
): ContactPermissionState {
	return {
		grantedByMe: state.grantedByMe,
		grantedByPeer: grantSet,
	};
}

export function findActiveGrantsByScope(
	grantSet: PermissionGrantSet,
	scope: string,
): PermissionGrant[] {
	return grantSet.grants.filter((grant) => grant.status === "active" && grant.scope === scope);
}

function normalizeGrantLike(input: unknown): PermissionGrant {
	if (typeof input !== "object" || input === null) {
		throw new ValidationError("Each grant must be an object");
	}

	const grant = input as {
		grantId?: unknown;
		scope?: unknown;
		constraints?: unknown;
		status?: unknown;
		updatedAt?: unknown;
	};

	if (typeof grant.grantId !== "string" || grant.grantId.length === 0) {
		throw new ValidationError("Each grant must include a non-empty grantId");
	}

	if (typeof grant.scope !== "string" || grant.scope.length === 0) {
		throw new ValidationError(`Grant ${grant.grantId} must include a non-empty scope`);
	}

	if (
		grant.constraints !== undefined &&
		(typeof grant.constraints !== "object" ||
			grant.constraints === null ||
			Array.isArray(grant.constraints))
	) {
		throw new ValidationError(`Grant ${grant.grantId} has invalid constraints`);
	}

	if (grant.status !== undefined && grant.status !== "active" && grant.status !== "revoked") {
		throw new ValidationError(`Grant ${grant.grantId} has invalid status`);
	}

	if (grant.updatedAt !== undefined && typeof grant.updatedAt !== "string") {
		throw new ValidationError(`Grant ${grant.grantId} has invalid updatedAt`);
	}

	return {
		grantId: grant.grantId,
		scope: grant.scope,
		...(grant.constraints ? { constraints: grant.constraints as Record<string, unknown> } : {}),
		status: grant.status ?? "active",
		updatedAt:
			typeof grant.updatedAt === "string" && grant.updatedAt.length > 0
				? grant.updatedAt
				: new Date().toISOString(),
	};
}
