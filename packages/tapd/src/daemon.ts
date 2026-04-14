import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ICalendarProvider,
	IConversationLogger,
	ITrustStore,
	TapMessagingService,
} from "trusted-agents-core";
import { generateAuthToken, persistAuthToken } from "./auth-token.js";
import type { TapdConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { Router } from "./http/router.js";
import { createConnectRoute } from "./http/routes/connect.js";
import { createContactsWriteRoutes } from "./http/routes/contacts-write.js";
import { createContactsRoutes } from "./http/routes/contacts.js";
import { createConversationsRoutes } from "./http/routes/conversations.js";
import {
	type DaemonControlOptions,
	createDaemonControlRoutes,
} from "./http/routes/daemon-control.js";
import { createFundsRequestsRoute } from "./http/routes/funds-requests.js";
import { createGrantsRoutes } from "./http/routes/grants.js";
import { type IdentitySource, createIdentityRoute } from "./http/routes/identity.js";
import { type InviteCreator, createInvitesRoute } from "./http/routes/invites.js";
import { createMeetingsRoutes } from "./http/routes/meetings.js";
import { createMessagesRoute } from "./http/routes/messages.js";
import { createNotificationsRoute } from "./http/routes/notifications.js";
import { createPendingRoutes } from "./http/routes/pending.js";
import { type TransferExecutor, createTransfersRoute } from "./http/routes/transfers.js";
import { TapdHttpServer } from "./http/server.js";
import { handleSseConnection } from "./http/sse.js";
import { classifyEventToNotification } from "./notification-classifier.js";
import { NotificationQueue } from "./notification-queue.js";
import { TapdRuntime } from "./runtime.js";

export const TAPD_VERSION = "0.2.0-beta.6";

export interface DaemonOptions {
	config: TapdConfig;
	identityAgentId: number;
	identitySource: IdentitySource;
	/** Factory that returns the service the daemon should own. */
	buildService: () => Promise<TapMessagingService>;
	trustStore: ITrustStore;
	conversationLogger: IConversationLogger;
	/**
	 * On-chain transfer executor invoked by `POST /api/transfers`. The host is
	 * responsible for wiring this to the OWS signing provider + the chain
	 * configs the daemon was started with. When omitted the route returns 500.
	 */
	executeTransfer?: TransferExecutor;
	/**
	 * Creates a signed TAP invite URL. Wired by the host to `generateInvite`
	 * from core using the daemon's signing provider. When omitted the
	 * `POST /api/invites` route returns 500.
	 */
	createInvite?: InviteCreator;
	/**
	 * Directory containing the bundled UI's static export. When set, tapd
	 * serves the UI at `/` and at any non-API GET path.
	 */
	staticAssetsDir?: string;
	/**
	 * Optional calendar provider used by `/api/meetings` when a client
	 * posts the flat shape with a `preferred` time but no explicit
	 * `slots`. Currently unused by `packages/tapd/src/bin.ts` (passes
	 * null) — the CLI command still resolves its own provider from
	 * `<dataDir>/config.yaml` via `resolveConfiguredCalendarProvider`. A
	 * shared calendar resolver in core is a follow-up.
	 */
	calendarProvider?: ICalendarProvider | null;
}

const PORT_FILE = ".tapd.port";

export class Daemon {
	private readonly options: DaemonOptions;
	private readonly bus: EventBus;
	private readonly notifications: NotificationQueue;
	private runtime: TapdRuntime | null = null;
	private server: TapdHttpServer | null = null;
	private token = "";
	private startedAt = 0;
	private shuttingDown = false;
	private signalHandlersInstalled = false;
	private shutdownResolve: (() => void) | null = null;
	private boundSigInt: (() => void) | null = null;
	private boundSigTerm: (() => void) | null = null;
	private notificationUnsubscribe: (() => void) | null = null;

	constructor(options: DaemonOptions) {
		this.options = options;
		this.bus = new EventBus({ ringBufferSize: options.config.ringBufferSize });
		this.notifications = new NotificationQueue();
	}

	async start(): Promise<void> {
		if (this.runtime) return;

		this.startedAt = Date.now();
		this.token = generateAuthToken();
		await persistAuthToken(this.options.config.dataDir, this.token);

		// Bus → NotificationQueue. Host plugins (Hermes, OpenClaw) drain the
		// queue on their pre-prompt hook; this is what keeps their context
		// notifications non-empty. Installed in start() (not the constructor)
		// so tests can wire alternate classifiers if needed, but the default
		// daemon always has the canonical producer hooked up.
		this.notificationUnsubscribe = this.bus.subscribe((event) => {
			const notification = classifyEventToNotification(event);
			if (notification) {
				this.notifications.enqueue(notification);
			}
		});

		const service = await this.options.buildService();
		this.runtime = new TapdRuntime({
			service,
			identityAgentId: this.options.identityAgentId,
			bus: this.bus,
		});
		await this.runtime.start();

		const router = this.buildRouter();
		this.server = new TapdHttpServer({
			router,
			socketPath: this.options.config.socketPath,
			tcpHost: this.options.config.tcpHost,
			tcpPort: this.options.config.tcpPort,
			authToken: this.token,
			staticAssetsDir: this.options.staticAssetsDir,
			sseHandler: (req, res, _transport) => {
				if (req.method !== "GET") return false;
				const url = req.url ?? "";
				const path = url.split("?")[0];
				if (path !== "/api/events/stream") return false;
				handleSseConnection(req, res, this.bus);
				return true;
			},
		});
		await this.server.start();

		// Publish the bound TCP port so clients (CLI `tap ui`, the Playwright
		// fixture) can discover where to reach us without parsing stdout.
		const boundPort = this.server.boundTcpPort();
		if (boundPort > 0) {
			await writeFile(join(this.options.config.dataDir, PORT_FILE), String(boundPort), {
				encoding: "utf-8",
				mode: 0o600,
			});
		}
	}

	async stop(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		if (this.server) {
			await this.server.stop();
			this.server = null;
		}
		if (this.runtime) {
			await this.runtime.stop();
			this.runtime = null;
		}
		if (this.notificationUnsubscribe) {
			this.notificationUnsubscribe();
			this.notificationUnsubscribe = null;
		}
		await rm(join(this.options.config.dataDir, PORT_FILE), {
			force: true,
		}).catch(() => {});
		this.removeSignalHandlers();
		if (this.shutdownResolve) {
			const resolve = this.shutdownResolve;
			this.shutdownResolve = null;
			resolve();
		}
	}

	authToken(): string {
		return this.token;
	}

	boundTcpPort(): number {
		return this.server?.boundTcpPort() ?? 0;
	}

	async runUntilSignal(): Promise<void> {
		await this.start();
		this.installSignalHandlers();
		await new Promise<void>((resolve) => {
			this.shutdownResolve = resolve;
		});
	}

	private installSignalHandlers(): void {
		if (this.signalHandlersInstalled) return;
		this.signalHandlersInstalled = true;
		this.boundSigInt = () => {
			void this.stop();
		};
		this.boundSigTerm = () => {
			void this.stop();
		};
		process.on("SIGINT", this.boundSigInt);
		process.on("SIGTERM", this.boundSigTerm);
	}

	private removeSignalHandlers(): void {
		if (!this.signalHandlersInstalled) return;
		if (this.boundSigInt) {
			process.off("SIGINT", this.boundSigInt);
			this.boundSigInt = null;
		}
		if (this.boundSigTerm) {
			process.off("SIGTERM", this.boundSigTerm);
			this.boundSigTerm = null;
		}
		this.signalHandlersInstalled = false;
	}

	private buildRouter(): Router {
		const router = new Router();

		const identityRoute = createIdentityRoute(this.options.identitySource);
		router.add("GET", "/api/identity", identityRoute);

		const contacts = createContactsRoutes(this.options.trustStore);
		router.add("GET", "/api/contacts", contacts.list);
		router.add("GET", "/api/contacts/:connectionId", contacts.get);

		const conversations = createConversationsRoutes(this.options.conversationLogger);
		router.add("GET", "/api/conversations", conversations.list);
		router.add("GET", "/api/conversations/:id", conversations.get);
		router.add("POST", "/api/conversations/:id/mark-read", conversations.markRead);

		const ensureRuntime = (): TapMessagingService => {
			if (!this.runtime) {
				throw new Error("daemon runtime is not running");
			}
			return this.runtime.tapMessagingService;
		};

		// Adapter exposing only the methods the pending routes need. We pass the
		// adapter (typed as `TapMessagingService`) so the routes don't need a
		// reference to the live runtime — they re-resolve it on every call.
		const pendingAdapter = {
			getStatus: () => ensureRuntime().getStatus(),
			resolvePending: (id: string, approve: boolean, reason?: string) =>
				ensureRuntime().resolvePending(id, approve, reason),
		} as unknown as TapMessagingService;
		const pending = createPendingRoutes(pendingAdapter);
		router.add("GET", "/api/pending", pending.list);
		router.add("POST", "/api/pending/:id/approve", pending.approve);
		router.add("POST", "/api/pending/:id/deny", pending.deny);

		// Write routes — adapters re-resolve the live runtime on every call so
		// they remain valid across daemon restarts that swap the service.
		const writeAdapter = {
			sendMessage: (
				peer: string,
				text: string,
				scope?: string,
				options?: { autoGenerated?: boolean },
			) => ensureRuntime().sendMessage(peer, text, scope, options),
			connect: (params: { inviteUrl: string; waitMs?: number }) => ensureRuntime().connect(params),
			requestFunds: (input: Parameters<TapMessagingService["requestFunds"]>[0]) =>
				ensureRuntime().requestFunds(input),
			requestMeeting: (input: Parameters<TapMessagingService["requestMeeting"]>[0]) =>
				ensureRuntime().requestMeeting(input),
			cancelMeeting: (schedulingId: string, reason?: string) =>
				ensureRuntime().cancelMeeting(schedulingId, reason),
			resolvePending: (id: string, approve: boolean, reason?: string) =>
				ensureRuntime().resolvePending(id, approve, reason),
			listPendingRequests: () => ensureRuntime().listPendingRequests(),
			publishGrantSet: (
				peer: string,
				grantSet: Parameters<TapMessagingService["publishGrantSet"]>[1],
				note?: string,
			) => ensureRuntime().publishGrantSet(peer, grantSet, note),
			requestGrantSet: (
				peer: string,
				grantSet: Parameters<TapMessagingService["requestGrantSet"]>[1],
				note?: string,
			) => ensureRuntime().requestGrantSet(peer, grantSet, note),
			revokeConnection: (
				contact: Parameters<TapMessagingService["revokeConnection"]>[0],
				reason?: string,
			) => ensureRuntime().revokeConnection(contact, reason),
		} as unknown as TapMessagingService;
		router.add("POST", "/api/messages", createMessagesRoute(writeAdapter));
		router.add("POST", "/api/connect", createConnectRoute(writeAdapter));
		router.add("POST", "/api/funds-requests", createFundsRequestsRoute(writeAdapter));

		const meetings = createMeetingsRoutes(writeAdapter, {
			calendarProvider: this.options.calendarProvider ?? null,
		});
		router.add("POST", "/api/meetings", meetings.request);
		router.add("POST", "/api/meetings/:id/respond", meetings.respond);
		router.add("POST", "/api/meetings/:id/cancel", meetings.cancel);

		const grants = createGrantsRoutes(writeAdapter);
		router.add("POST", "/api/grants/publish", grants.publish);
		router.add("POST", "/api/grants/request", grants.request);

		const contactsWrite = createContactsWriteRoutes(writeAdapter, this.options.trustStore);
		router.add("POST", "/api/contacts/:connectionId/revoke", contactsWrite.revoke);

		const executeTransfer: TransferExecutor = (request) => {
			const fn = this.options.executeTransfer;
			if (!fn) {
				throw new Error(
					"transfers route is not wired: pass executeTransfer when constructing the daemon",
				);
			}
			return fn(request);
		};
		router.add("POST", "/api/transfers", createTransfersRoute(executeTransfer));

		const createInvite: InviteCreator = (request) => {
			const fn = this.options.createInvite;
			if (!fn) {
				throw new Error(
					"invites route is not wired: pass createInvite when constructing the daemon",
				);
			}
			return fn(request);
		};
		router.add("POST", "/api/invites", createInvitesRoute(createInvite));

		const notifications = createNotificationsRoute(this.notifications);
		router.add("GET", "/api/notifications/drain", notifications);

		const controlOptions: DaemonControlOptions = {
			version: TAPD_VERSION,
			startedAt: this.startedAt,
			isTransportConnected: () => this.runtime !== null,
			lastSyncAt: () => undefined,
			triggerSync: async () => {
				const service = ensureRuntime();
				return await service.syncOnce();
			},
			requestShutdown: () => {
				void this.stop();
			},
		};
		const control = createDaemonControlRoutes(controlOptions);
		router.add("GET", "/daemon/health", control.health);
		router.add("POST", "/daemon/sync", control.sync);
		router.add("POST", "/daemon/shutdown", control.shutdown);

		return router;
	}
}
