import type { RouteHandler } from "../router.js";

export interface DaemonControlOptions {
	version: string;
	startedAt: number;
	isTransportConnected: () => boolean;
	lastSyncAt: () => string | undefined;
	triggerSync: () => Promise<void>;
	requestShutdown: () => void;
}

export interface DaemonHealthResponse {
	status: "ok";
	version: string;
	uptime: number;
	transportConnected: boolean;
	lastSyncAt?: string;
}

export interface DaemonControlRoutes {
	health: RouteHandler<unknown, DaemonHealthResponse>;
	sync: RouteHandler<unknown, { ok: true }>;
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
			await opts.triggerSync();
			return { ok: true };
		},
		shutdown: async () => {
			opts.requestShutdown();
			return { ok: true };
		},
	};
}
