import { nowISO } from "../common/index.js";

export const TAP_GRANTS_VERSION = "tap-grants/v1" as const;

export type PermissionGrantStatus = "active" | "revoked";

export interface PermissionGrant {
	grantId: string;
	scope: string;
	constraints?: Record<string, unknown>;
	status: PermissionGrantStatus;
	updatedAt: string;
}

export interface PermissionGrantSet {
	version: typeof TAP_GRANTS_VERSION;
	updatedAt: string;
	grants: PermissionGrant[];
}

export interface ContactPermissionState {
	grantedByMe: PermissionGrantSet;
	grantedByPeer: PermissionGrantSet;
}

function createGrant(
	input: Omit<PermissionGrant, "updatedAt" | "status"> & {
		status?: PermissionGrantStatus;
		updatedAt?: string;
	},
	timestamp: string = nowISO(),
): PermissionGrant {
	return {
		grantId: input.grantId,
		scope: input.scope,
		...(input.constraints ? { constraints: input.constraints } : {}),
		status: input.status ?? "active",
		updatedAt: input.updatedAt ?? timestamp,
	};
}

function createEmptyGrantSet(timestamp: string = nowISO()): PermissionGrantSet {
	return {
		version: TAP_GRANTS_VERSION,
		updatedAt: timestamp,
		grants: [],
	};
}

export function createGrantSet(
	grants: Array<
		Omit<PermissionGrant, "updatedAt" | "status"> & {
			status?: PermissionGrantStatus;
			updatedAt?: string;
		}
	>,
	timestamp: string = nowISO(),
): PermissionGrantSet {
	return {
		version: TAP_GRANTS_VERSION,
		updatedAt: timestamp,
		grants: grants.map((grant) => createGrant(grant, timestamp)),
	};
}

export function createEmptyPermissionState(timestamp: string = nowISO()): ContactPermissionState {
	return {
		grantedByMe: createEmptyGrantSet(timestamp),
		grantedByPeer: createEmptyGrantSet(timestamp),
	};
}
