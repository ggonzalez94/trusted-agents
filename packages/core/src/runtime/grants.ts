import { ValidationError, isNonEmptyString, isObject, isRecord } from "../common/index.js";
import {
	type ContactPermissionState,
	type PermissionGrant,
	type PermissionGrantSet,
	TAP_GRANTS_VERSION,
	createGrantSet,
} from "../permissions/index.js";

export function normalizeGrantInput(input: unknown): PermissionGrantSet {
	if (Array.isArray(input)) {
		return createGrantSet(input.map(normalizeGrantLike));
	}

	if (!isObject(input)) {
		throw new ValidationError("Grant input must be a JSON object or array");
	}

	if (!Array.isArray(input.grants)) {
		throw new ValidationError('Grant object must include a "grants" array');
	}

	const grantSet = createGrantSet(input.grants.map(normalizeGrantLike));
	if (input.version !== undefined && input.version !== TAP_GRANTS_VERSION) {
		throw new ValidationError(
			`Unsupported grant set version: ${String(input.version)}. Expected ${TAP_GRANTS_VERSION}`,
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
	if (!isObject(input)) {
		throw new ValidationError("Each grant must be an object");
	}

	if (!isNonEmptyString(input.grantId)) {
		throw new ValidationError("Each grant must include a non-empty grantId");
	}

	if (!isNonEmptyString(input.scope)) {
		throw new ValidationError(`Grant ${input.grantId} must include a non-empty scope`);
	}

	if (input.constraints !== undefined && !isRecord(input.constraints)) {
		throw new ValidationError(`Grant ${input.grantId} has invalid constraints`);
	}

	if (input.status !== undefined && input.status !== "active" && input.status !== "revoked") {
		throw new ValidationError(`Grant ${input.grantId} has invalid status`);
	}

	if (input.updatedAt !== undefined && typeof input.updatedAt !== "string") {
		throw new ValidationError(`Grant ${input.grantId} has invalid updatedAt`);
	}

	return {
		grantId: input.grantId,
		scope: input.scope,
		...(input.constraints ? { constraints: input.constraints } : {}),
		status: input.status ?? "active",
		updatedAt: isNonEmptyString(input.updatedAt) ? input.updatedAt : new Date().toISOString(),
	};
}
