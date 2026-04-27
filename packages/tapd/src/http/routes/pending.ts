import type { TapMessagingService, TapPendingRequest } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { readOptionalStringField, requireParam } from "../validation.js";

export interface PendingRoutes {
	list: RouteHandler<unknown, TapPendingRequest[]>;
	approve: RouteHandler<unknown, { resolved: true }>;
	deny: RouteHandler<unknown, { resolved: true }>;
}

export function createPendingRoutes(service: TapMessagingService): PendingRoutes {
	return {
		list: async () => {
			const status = await service.getStatus();
			return status.pendingRequests;
		},
		approve: async (params, body) => {
			const id = requireParam(params, "id");
			await service.resolvePending(id, true, readOptionalStringField(body, "note"));
			return { resolved: true };
		},
		deny: async (params, body) => {
			const id = requireParam(params, "id");
			await service.resolvePending(id, false, readOptionalStringField(body, "reason"));
			return { resolved: true };
		},
	};
}
