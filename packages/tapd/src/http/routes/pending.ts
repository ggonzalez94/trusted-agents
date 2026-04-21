import type { TapMessagingService, TapPendingRequest } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { asRecord, requireParam } from "../validation.js";

export interface PendingRoutes {
	list: RouteHandler<unknown, TapPendingRequest[]>;
	approve: RouteHandler<unknown, { resolved: true }>;
	deny: RouteHandler<unknown, { resolved: true }>;
}

function readStringField(body: unknown, key: string): string | undefined {
	const value = asRecord(body)?.[key];
	return typeof value === "string" ? value : undefined;
}

export function createPendingRoutes(service: TapMessagingService): PendingRoutes {
	return {
		list: async () => {
			const status = await service.getStatus();
			return status.pendingRequests;
		},
		approve: async (params, body) => {
			const id = requireParam(params, "id");
			await service.resolvePending(id, true, readStringField(body, "note"));
			return { resolved: true };
		},
		deny: async (params, body) => {
			const id = requireParam(params, "id");
			await service.resolvePending(id, false, readStringField(body, "reason"));
			return { resolved: true };
		},
	};
}
