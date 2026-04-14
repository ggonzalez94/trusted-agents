import type { TapSyncReport } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface DaemonControlOptions {
	version: string;
	startedAt: number;
	isTransportConnected: () => boolean;
	lastSyncAt: () => string | undefined;
	triggerSync: () => Promise<TapSyncReport | void>;
	requestShutdown: () => void;
}

export interface DaemonHealthResponse {
	status: "ok";
	version: string;
	uptime: number;
	transportConnected: boolean;
	lastSyncAt?: string;
}

export interface DaemonSyncResponse {
	ok: true;
	report?: TapSyncReport;
}

export interface DaemonControlRoutes {
	health: RouteHandler<unknown, DaemonHealthResponse>;
	sync: RouteHandler<unknown, DaemonSyncResponse>;
	shutdown: RouteHandler<unknown, { ok: true }>;
}

export function createDaemonControlRoutes(opts: DaemonControlOptions): DaemonControlRoutes {
	return {
		health: async () => {
			const lastSyncAt = opts.lastSyncAt();
			return {
				status: "ok" as const,
				version: opts.version,
				uptime: Date.now() - opts.startedAt,
				transportConnected: opts.isTransportConnected(),
				...(lastSyncAt ? { lastSyncAt } : {}),
			};
		},
		sync: async () => {
			const report = await opts.triggerSync();
			return report ? { ok: true as const, report } : { ok: true as const };
		},
		shutdown: async () => {
			opts.requestShutdown();
			return { ok: true };
		},
	};
}
