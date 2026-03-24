import type { PluginLogger, PluginRuntime } from "openclaw/plugin-sdk";
import {
	AsyncMutex,
	type PermissionGrantSet,
	SchedulingHandler,
	type SchedulingProposal,
	TapMessagingService,
	type TapPendingSchedulingDetails,
	type TapRequestFundsInput,
	type TapServiceStatus,
	type TrustedAgentsConfig,
	buildDefaultTapRuntimeContext,
	executeOnchainTransfer,
	generateSchedulingId,
	loadTrustedAgentConfigFromDataDir,
} from "trusted-agents-core";
import { generateInvite } from "trusted-agents-core";
import type { TapOpenClawIdentityConfig, TapOpenClawPluginConfig } from "./config.js";
import { type TapEmitEventPayload, classifyTapEvent } from "./event-classifier.js";
import { type TapNotification, TapNotificationQueue } from "./notification-queue.js";

function sanitizeOneLiner(text: string): string {
	return text.replace(/[\n\r\t]+/g, " ").trim();
}

function truncateText(text: string, maxLen: number): string {
	const sanitized = sanitizeOneLiner(text);
	if (sanitized.length <= maxLen) return sanitized;
	return `${sanitized.slice(0, maxLen)}...`;
}

interface ManagedTapRuntime {
	definition: TapOpenClawIdentityConfig;
	config: TrustedAgentsConfig;
	service: TapMessagingService;
	mutex: AsyncMutex;
	interval: NodeJS.Timeout | null;
	lastError?: string;
}

interface OpenClawTapEscalationTarget {
	sessionKey: string;
	system: Pick<PluginRuntime["system"], "enqueueSystemEvent" | "requestHeartbeatNow">;
}

export class OpenClawTapRegistry {
	private readonly runtimes = new Map<string, ManagedTapRuntime>();
	private readonly notificationQueues = new Map<string, TapNotificationQueue>();
	private startPromise: Promise<void> | null = null;
	private started = false;

	constructor(
		private readonly pluginConfig: TapOpenClawPluginConfig,
		private readonly logger: PluginLogger,
		private readonly escalationTarget?: OpenClawTapEscalationTarget,
	) {}

	drainNotifications(): TapNotification[] {
		const all: TapNotification[] = [];
		for (const queue of this.notificationQueues.values()) {
			all.push(...queue.drain());
		}
		return all;
	}

	listConfiguredIdentities(): string[] {
		return this.pluginConfig.identities.map((identity) => identity.name);
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		if (this.startPromise) {
			await this.startPromise;
			return;
		}

		this.startPromise = this.startAll();
		try {
			await this.startPromise;
			this.started = true;
		} finally {
			this.startPromise = null;
		}
	}

	async stop(): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			if (runtime.interval) {
				clearInterval(runtime.interval);
				runtime.interval = null;
			}
			await runtime.mutex.runExclusive(async () => {
				await runtime.service.stop().catch((error: unknown) => {
					this.logger.warn(
						`[trusted-agents-tap] Failed to stop ${runtime.definition.name}: ${formatError(error)}`,
					);
				});
			});
		}
		this.runtimes.clear();
		this.notificationQueues.clear();
		this.started = false;
	}

	async status(identity?: string): Promise<{
		configured: boolean;
		configuredIdentities: string[];
		warnings: string[];
		identities: Array<{
			identity: string;
			dataDir: string;
			running: boolean;
			lastSyncAt?: string;
			lock: TapServiceStatus["lock"];
			pendingRequests: TapServiceStatus["pendingRequests"];
			lastError?: string;
		}>;
	}> {
		const names = this.resolveIdentitySelection(identity);
		const identities = await Promise.all(
			names.map(async (name) => {
				try {
					const runtime = await this.ensureRuntime(name);
					const status = await runtime.mutex.runExclusive(
						async () => await runtime.service.getStatus(),
					);
					return {
						identity: name,
						dataDir: runtime.definition.dataDir,
						running: status.running,
						lastSyncAt: status.lastSyncAt,
						lock: status.lock,
						pendingRequests: status.pendingRequests,
						lastError: runtime.lastError,
					};
				} catch (error: unknown) {
					const definition = this.pluginConfig.identities.find((entry) => entry.name === name);
					return {
						identity: name,
						dataDir: definition?.dataDir ?? "",
						running: false,
						lock: null,
						pendingRequests: [],
						lastError: formatError(error),
					};
				}
			}),
		);

		return {
			configured: this.pluginConfig.identities.length > 0,
			configuredIdentities: this.listConfiguredIdentities(),
			warnings: this.buildWarnings(identities),
			identities,
		};
	}

	async sync(identity?: string): Promise<{
		results: Array<{
			identity: string;
			synced: boolean;
			processed: number;
			pendingRequests: TapServiceStatus["pendingRequests"];
		}>;
	}> {
		const names = this.resolveIdentitySelection(identity);
		const results = await Promise.all(
			names.map(async (name) => {
				const runtime = await this.ensureRuntimeStarted(name);
				const report = await runtime.mutex.runExclusive(
					async () => await runtime.service.syncOnce(),
				);
				runtime.lastError = undefined;
				return {
					identity: name,
					synced: report.synced,
					processed: report.processed,
					pendingRequests: report.pendingRequests,
				};
			}),
		);
		return { results };
	}

	async restart(identity?: string): Promise<{
		restarted: string[];
		status: Awaited<ReturnType<OpenClawTapRegistry["status"]>>;
	}> {
		const names = this.resolveIdentitySelection(identity);
		for (const name of names) {
			await this.restartRuntime(name);
		}
		return {
			restarted: names,
			status: await this.status(identity),
		};
	}

	async createInvite(
		identity: string | undefined,
		expirySeconds?: number,
	): Promise<{
		identity: string;
		url: string;
		expiresInSeconds: number;
	}> {
		const runtime = await this.ensureRuntimeForAction(identity);
		return await runtime.mutex.runExclusive(async () => {
			const expiresIn = expirySeconds ?? runtime.config.inviteExpirySeconds;
			const result = await generateInvite({
				agentId: runtime.config.agentId,
				chain: runtime.config.chain,
				account: runtime.config.account,
				expirySeconds: expiresIn,
			});
			return {
				identity: runtime.definition.name,
				url: result.url,
				expiresInSeconds: expiresIn,
			};
		});
	}

	async connect(params: {
		identity?: string;
		inviteUrl: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		return await runtime.mutex.runExclusive(
			async () =>
				await runtime.service.connect({
					inviteUrl: params.inviteUrl,
				}),
		);
	}

	async sendMessage(params: {
		identity?: string;
		peer: string;
		text: string;
		scope?: string;
		autoGenerated?: boolean;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		return await runtime.mutex.runExclusive(
			async () =>
				await runtime.service.sendMessage(
					params.peer,
					params.text,
					params.scope,
					params.autoGenerated ? { autoGenerated: true } : undefined,
				),
		);
	}

	async publishGrantSet(params: {
		identity?: string;
		peer: string;
		grantSet: PermissionGrantSet;
		note?: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		return await runtime.mutex.runExclusive(
			async () => await runtime.service.publishGrantSet(params.peer, params.grantSet, params.note),
		);
	}

	async requestGrantSet(params: {
		identity?: string;
		peer: string;
		grantSet: PermissionGrantSet;
		note?: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		return await runtime.mutex.runExclusive(
			async () => await runtime.service.requestGrantSet(params.peer, params.grantSet, params.note),
		);
	}

	async requestFunds(params: {
		identity?: string;
		peer: string;
		asset: "native" | "usdc";
		amount: string;
		chain?: string;
		toAddress?: `0x${string}`;
		note?: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		const input: TapRequestFundsInput = {
			peer: params.peer,
			asset: params.asset,
			amount: params.amount,
			chain: params.chain ?? runtime.config.chain,
			toAddress: params.toAddress ?? runtime.config.account.address,
			note: params.note,
		};
		return await runtime.mutex.runExclusive(async () => await runtime.service.requestFunds(input));
	}

	async transfer(params: {
		identity?: string;
		asset: "native" | "usdc";
		amount: string;
		chain?: string;
		toAddress: `0x${string}`;
	}): Promise<{
		identity: string;
		status: "submitted";
		asset: string;
		amount: string;
		chain: string;
		to_address: string;
		tx_hash: string;
	}> {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		const chain = params.chain ?? runtime.config.chain;
		const result = await runtime.mutex.runExclusive(
			async () =>
				await executeOnchainTransfer(runtime.config, {
					type: "transfer/request",
					actionId: `gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					asset: params.asset,
					amount: params.amount,
					chain,
					toAddress: params.toAddress,
				}),
		);
		return {
			identity: runtime.definition.name,
			status: "submitted",
			asset: params.asset,
			amount: params.amount,
			chain,
			to_address: params.toAddress,
			tx_hash: result.txHash,
		};
	}

	async requestMeeting(params: {
		identity?: string;
		peer: string;
		title: string;
		duration: number;
		preferred?: string;
		location?: string;
		note?: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);

		const schedulingId = generateSchedulingId();
		const durationMs = params.duration * 60 * 1000;

		let slotStart: Date;
		if (params.preferred) {
			slotStart = new Date(params.preferred);
			if (Number.isNaN(slotStart.getTime())) {
				throw new Error(`Invalid preferred time: ${params.preferred}. Use ISO 8601 format.`);
			}
		} else {
			slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
		}
		const slotEnd = new Date(slotStart.getTime() + durationMs);
		const originTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

		const proposal: SchedulingProposal = {
			type: "scheduling/propose",
			schedulingId,
			title: params.title,
			duration: params.duration,
			slots: [{ start: slotStart.toISOString(), end: slotEnd.toISOString() }],
			originTimezone,
			...(params.location ? { location: params.location } : {}),
			...(params.note ? { note: params.note } : {}),
		};

		return await runtime.mutex.runExclusive(
			async () => await runtime.service.requestMeeting({ peer: params.peer, proposal }),
		);
	}

	async respondMeeting(params: {
		identity?: string;
		schedulingId: string;
		action: string;
		reason?: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		const approve = params.action === "accept";

		const pending = await runtime.mutex.runExclusive(
			async () => await runtime.service.listPendingRequests(),
		);
		const matching = pending.find(
			(r) =>
				r.direction === "inbound" &&
				r.details?.type === "scheduling" &&
				(r.details as TapPendingSchedulingDetails).schedulingId === params.schedulingId,
		);

		if (!matching) {
			throw new Error(
				`No pending scheduling request found with schedulingId: ${params.schedulingId}`,
			);
		}

		const report = await runtime.mutex.runExclusive(
			async () => await runtime.service.resolvePending(matching.requestId, approve, params.reason),
		);

		return {
			identity: runtime.definition.name,
			resolved: true,
			schedulingId: params.schedulingId,
			action: params.action,
			requestId: matching.requestId,
			...(params.reason ? { reason: params.reason } : {}),
			pendingRequests: report.pendingRequests.length,
		};
	}

	async cancelMeeting(params: {
		identity?: string;
		schedulingId: string;
		reason?: string;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);

		const pending = await runtime.mutex.runExclusive(
			async () => await runtime.service.listPendingRequests(),
		);
		const matching = pending.find(
			(r) =>
				r.direction === "outbound" &&
				r.details?.type === "scheduling" &&
				(r.details as TapPendingSchedulingDetails).schedulingId === params.schedulingId,
		);

		if (!matching) {
			throw new Error(
				`No scheduling request found with schedulingId: ${params.schedulingId}. It may have already been completed or cancelled.`,
			);
		}

		const report = await runtime.mutex.runExclusive(
			async () =>
				await runtime.service.cancelPendingSchedulingRequest(matching.requestId, params.reason),
		);

		return {
			identity: runtime.definition.name,
			cancelled: true,
			schedulingId: params.schedulingId,
			requestId: matching.requestId,
			...(params.reason ? { reason: params.reason } : {}),
			pendingRequests: report.pendingRequests.length,
		};
	}

	async listPending(identity?: string) {
		const names = this.resolveIdentitySelection(identity);
		const results = await Promise.all(
			names.map(async (name) => {
				const runtime = await this.ensureRuntime(name);
				const pending = await runtime.mutex.runExclusive(
					async () => await runtime.service.listPendingRequests(),
				);
				return {
					identity: name,
					pendingRequests: pending,
				};
			}),
		);
		return { identities: results };
	}

	async resolvePending(params: {
		identity?: string;
		requestId: string;
		approve: boolean;
	}) {
		const runtime = await this.ensureRuntimeForAction(params.identity);
		const report = await runtime.mutex.runExclusive(
			async () => await runtime.service.resolvePending(params.requestId, params.approve),
		);
		return {
			identity: runtime.definition.name,
			approved: params.approve,
			requestId: params.requestId,
			sync: report,
		};
	}

	private async startAll(): Promise<void> {
		if (this.pluginConfig.identities.length === 0) {
			this.logger.warn(
				"[trusted-agents-tap] No TAP identities are configured. Set plugins.entries.trusted-agents-tap.config.identities and restart Gateway.",
			);
			return;
		}

		const failures: string[] = [];
		for (const identity of this.pluginConfig.identities) {
			try {
				const runtime = await this.ensureRuntime(identity.name);
				await this.startRuntime(runtime);
			} catch (error: unknown) {
				const message = formatError(error);
				failures.push(`${identity.name}: ${message}`);
				this.logger.warn(
					`[trusted-agents-tap:${identity.name}] Failed to start TAP runtime: ${message}`,
				);
			}
		}

		if (failures.length > 0) {
			this.logger.warn(
				`[trusted-agents-tap] ${failures.length}/${this.pluginConfig.identities.length} TAP identities failed to start: ${failures.join("; ")}. Plugin will continue in degraded mode — use tap_gateway action "restart" to retry.`,
			);
		}
	}

	private async ensureRuntimeForAction(identity?: string): Promise<ManagedTapRuntime> {
		const name = this.resolveSingleIdentity(identity);
		return await this.ensureRuntimeStarted(name);
	}

	private async ensureRuntimeStarted(name: string): Promise<ManagedTapRuntime> {
		const runtime = await this.ensureRuntime(name);
		await runtime.mutex.runExclusive(async () => {
			try {
				await runtime.service.start();
				runtime.lastError = undefined;
			} catch (error: unknown) {
				runtime.lastError = formatError(error);
				throw error;
			}
		});
		this.installInterval(runtime);
		return runtime;
	}

	private async ensureRuntime(name: string): Promise<ManagedTapRuntime> {
		const existing = this.runtimes.get(name);
		if (existing) {
			return existing;
		}

		const definition = this.pluginConfig.identities.find((identity) => identity.name === name);
		if (!definition) {
			throw new Error(`Unknown TAP identity: ${name}`);
		}

		const config = await loadTrustedAgentConfigFromDataDir(definition.dataDir, {
			requireAgentId: true,
		});
		const context = buildDefaultTapRuntimeContext(config);
		const notificationQueue = new TapNotificationQueue();
		this.notificationQueues.set(name, notificationQueue);
		const schedulingHandler = new SchedulingHandler({
			hooks: {
				approveScheduling: async () => {
					return null; // Defer for operator approval
				},
			},
		});
		const runtime: ManagedTapRuntime = {
			definition,
			config,
			service: new TapMessagingService(context, {
				ownerLabel: `openclaw:${definition.name}`,
				schedulingHandler,
				hooks: {
					executeTransfer: async (serviceConfig, request) =>
						await executeOnchainTransfer(serviceConfig, request),
					log: (level, message) => {
						logWithLevel(this.logger, level, `[trusted-agents-tap:${definition.name}] ${message}`);
					},
					emitEvent: (payload) => {
						this.handleEmitEvent(name, notificationQueue, payload);
					},
					approveTransfer: async ({ requestId, contact, request, activeTransferGrants }) => {
						// The hook fires BEFORE emitEvent in the core runtime's async task
						// flow, so we push new notifications here instead of upgrading —
						// the classifier returns null for transfer requests to avoid duplicates.
						if (activeTransferGrants.length > 0) {
							const grantEnqueued = notificationQueue.push({
								type: "summary",
								identity: name,
								timestamp: new Date().toISOString(),
								method: "action/request",
								from: contact.peerAgentId,
								fromName: contact.peerDisplayName,
								messageId: requestId,
								detail: { asset: request.asset, amount: request.amount },
								oneLiner: `Approved ${request.amount} ${request.asset} transfer to ${contact.peerDisplayName} (covered by grant)`,
							});
							if (grantEnqueued) {
								void this.triggerEscalation(
									`Auto-approved ${request.amount} ${request.asset} transfer to ${contact.peerDisplayName}`,
								);
							}
							return true;
						}
						const enqueued = notificationQueue.push({
							type: "escalation",
							identity: name,
							timestamp: new Date().toISOString(),
							method: "action/request",
							from: contact.peerAgentId,
							fromName: contact.peerDisplayName,
							messageId: requestId,
							detail: { asset: request.asset, amount: request.amount },
							oneLiner: `Transfer request from ${contact.peerDisplayName}: ${request.amount} ${request.asset} — needs approval`,
						});
						if (enqueued) {
							void this.triggerEscalation(
								`Transfer request from ${contact.peerDisplayName} (${request.amount} ${request.asset}) requires approval`,
							);
						}
						return null;
					},
					approveConnection: async () => {
						return null; // Always escalate to user
					},
					confirmMeeting: async () => {
						// Return false to prevent auto-confirmation; operator resolves via tap_gateway
						return false;
					},
					onMeetingConfirmed: async (meeting) => {
						const enqueued = notificationQueue.push({
							type: "summary",
							identity: name,
							timestamp: new Date().toISOString(),
							method: "scheduling/accept",
							from: meeting.peerAgentId,
							fromName: meeting.peerName,
							messageId: meeting.schedulingId,
							detail: {
								schedulingId: meeting.schedulingId,
								title: meeting.title,
								slot: meeting.slot,
								eventId: meeting.eventId,
							},
							oneLiner: `Meeting confirmed with ${meeting.peerName}: "${meeting.title}"`,
						});
						if (enqueued) {
							void this.triggerEscalation(
								`Meeting confirmed with ${meeting.peerName}: "${meeting.title}"`,
							);
						}
					},
				},
			}),
			mutex: new AsyncMutex(),
			interval: null,
		};
		this.runtimes.set(name, runtime);
		return runtime;
	}

	private async startRuntime(runtime: ManagedTapRuntime): Promise<void> {
		await runtime.mutex.runExclusive(async () => {
			try {
				await runtime.service.start();
				runtime.lastError = undefined;
			} catch (error: unknown) {
				runtime.lastError = formatError(error);
				throw error;
			}
		});
		this.installInterval(runtime);
	}

	private async restartRuntime(name: string): Promise<void> {
		const existing = this.runtimes.get(name);
		if (existing) {
			if (existing.interval) {
				clearInterval(existing.interval);
			}
			await existing.mutex.runExclusive(async () => {
				await existing.service.stop().catch(() => {});
			});
			this.runtimes.delete(name);
			this.notificationQueues.delete(name);
		}

		const runtime = await this.ensureRuntime(name);
		await this.startRuntime(runtime);
	}

	private installInterval(runtime: ManagedTapRuntime): void {
		if (runtime.interval) {
			clearInterval(runtime.interval);
		}

		runtime.interval = setInterval(() => {
			void runtime.mutex.runExclusive(async () => {
				try {
					await runtime.service.syncOnce();
					runtime.lastError = undefined;
				} catch (error: unknown) {
					runtime.lastError = formatError(error);
					this.logger.warn(
						`[trusted-agents-tap:${runtime.definition.name}] Periodic reconcile failed: ${runtime.lastError}`,
					);
				}
			});
		}, runtime.definition.reconcileIntervalMinutes * 60_000);
	}

	private handleEmitEvent(
		identity: string,
		queue: TapNotificationQueue,
		payload: Record<string, unknown>,
	): void {
		const event = payload as TapEmitEventPayload;
		const bucket = classifyTapEvent(event);
		if (bucket === null) return;

		// Override notification type for message/send based on autoGenerated flag
		let notificationType: TapNotification["type"];
		if (event.method === "message/send") {
			notificationType = event.autoGenerated ? "summary" : "auto-reply";
		} else {
			notificationType =
				bucket === "auto-handle" ? "summary" : bucket === "escalate" ? "escalation" : "info";
		}

		const notification: TapNotification = {
			type: notificationType,
			identity,
			timestamp: (event.timestamp as string) ?? new Date().toISOString(),
			method: event.method,
			from: event.from,
			fromName: event.fromName,
			messageId: String(event.id),
			detail: payload,
			oneLiner: this.buildOneLiner(event),
		};

		const enqueued = queue.push(notification);

		if (enqueued) {
			const peer = event.fromName ?? `agent #${event.from}`;
			void this.triggerEscalation(`Incoming ${event.method} from ${peer}`);
		}
	}

	private triggerEscalation(description: string): void {
		if (!this.escalationTarget) {
			return;
		}

		try {
			this.escalationTarget.system.enqueueSystemEvent(`TAP: ${description}`, {
				sessionKey: this.escalationTarget.sessionKey,
				contextKey: "tap:escalation",
			});
			this.escalationTarget.system.requestHeartbeatNow({
				reason: "hook:tap-escalation",
				coalesceMs: 2000,
				sessionKey: this.escalationTarget.sessionKey,
			});
		} catch (error: unknown) {
			this.logger.warn(
				`[trusted-agents-tap] Failed to trigger OpenClaw heartbeat wake: ${formatError(error)}`,
			);
		}
	}

	private buildOneLiner(event: TapEmitEventPayload): string {
		const peer = event.fromName ?? `agent #${event.from}`;
		switch (event.method) {
			case "message/send": {
				const preview = truncateText(String(event.messageText ?? ""), 200);
				if (!preview) {
					return `Received a data-only message from ${peer}`;
				}
				if (event.autoGenerated) {
					return `Auto-reply from ${peer}: "${preview}"`;
				}
				return `${peer} said: "${preview}" → Reply with tap_gateway send_message (set autoGenerated=true), then summarize to the user.`;
			}
			case "action/result":
				return `Action result received from ${peer}`;
			case "permissions/update":
				return `Grant update from ${peer}`;
			case "connection/request":
				return `Connection request from ${peer}`;
			case "connection/result":
				return `Connection confirmed with ${peer}`;
			case "action/request":
				return `Action request from ${peer}`;
			case "scheduling/propose":
				return `Meeting proposal from ${peer}`;
			case "scheduling/counter":
				return `Counter-proposal from ${peer}`;
			case "scheduling/accept":
				return `Meeting accepted by ${peer}`;
			case "scheduling/reject":
				return `Meeting rejected by ${peer}`;
			case "scheduling/cancel":
				return `Meeting cancelled by ${peer}`;
			default:
				return `TAP event: ${event.method} from ${peer}`;
		}
	}

	private resolveIdentitySelection(identity?: string): string[] {
		if (identity) {
			return [this.resolveSingleIdentity(identity)];
		}
		return this.listConfiguredIdentities();
	}

	private resolveSingleIdentity(identity?: string): string {
		if (identity) {
			const match = this.pluginConfig.identities.find((item) => item.name === identity);
			if (!match) {
				throw new Error(`Unknown TAP identity: ${identity}`);
			}
			return match.name;
		}

		if (this.pluginConfig.identities.length === 0) {
			throw new Error("No TAP identities are configured in the OpenClaw plugin");
		}
		if (this.pluginConfig.identities.length > 1) {
			throw new Error(
				"Multiple TAP identities are configured. Specify the identity name in the tool call.",
			);
		}
		return this.pluginConfig.identities[0]!.name;
	}

	private buildWarnings(
		identities: Array<{
			identity: string;
			running: boolean;
			lastError?: string;
		}>,
	): string[] {
		const warnings: string[] = [];
		if (this.pluginConfig.identities.length === 0) {
			warnings.push(
				"No TAP identities are configured. Set plugins.entries.trusted-agents-tap.config.identities and restart Gateway.",
			);
		}

		for (const identity of identities) {
			if (identity.lastError) {
				warnings.push(`TAP identity "${identity.identity}" is degraded: ${identity.lastError}`);
				continue;
			}
			if (!identity.running) {
				warnings.push(
					`TAP identity "${identity.identity}" is stopped. Use tap_gateway action "restart" or restart Gateway.`,
				);
			}
		}

		return warnings;
	}
}

function logWithLevel(
	logger: PluginLogger,
	level: "info" | "warn" | "error",
	message: string,
): void {
	if (level === "error") {
		logger.error(message);
		return;
	}
	if (level === "warn") {
		logger.warn(message);
		return;
	}
	logger.info(message);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
