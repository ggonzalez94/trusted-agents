import type { TapMessagingService, TapPendingRequest } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface PendingRoutes {
	list: RouteHandler<unknown, TapPendingRequest[]>;
	approve: RouteHandler<unknown, { resolved: true }>;
	deny: RouteHandler<unknown, { resolved: true }>;
}

function readStringField(body: unknown, key: string): string | undefined {
	if (body && typeof body === "object" && key in body) {
		const value = (body as Record<string, unknown>)[key];
		if (typeof value === "string") return value;
	}
	return undefined;
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
			await service.resolvePending(id, true, readStringField(body, "note"));
			return { resolved: true };
		},
		deny: async (params, body) => {
			const id = params.id;
			if (!id) {
				throw new Error("missing pending id");
			}
			await service.resolvePending(id, false, readStringField(body, "reason"));
			return { resolved: true };
		},
	};
}
