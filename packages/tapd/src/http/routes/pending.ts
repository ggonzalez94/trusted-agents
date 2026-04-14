import type { TapMessagingService, TapPendingRequest } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface PendingRoutes {
	list: RouteHandler<unknown, TapPendingRequest[]>;
	approve: RouteHandler<{ note?: string }, { resolved: true }>;
	deny: RouteHandler<{ reason?: string }, { resolved: true }>;
}

export function createPendingRoutes(service: TapMessagingService): PendingRoutes {
	return {
		list: async () => {
			const status = await service.getStatus();
			return status.pendingRequests;
		},
		approve: async (params, body) => {
			const id = params.id;
			if (!id) {
				throw new Error("missing pending id");
			}
			await service.resolvePending(id, true, body?.note);
			return { resolved: true };
		},
		deny: async (params, body) => {
			const id = params.id;
			if (!id) {
				throw new Error("missing pending id");
			}
			await service.resolvePending(id, false, body?.reason);
			return { resolved: true };
		},
	};
}
