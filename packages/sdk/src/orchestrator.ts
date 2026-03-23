import {
	FileTrustStore,
	type ICalendarProvider,
	SchedulingHandler,
	TapMessagingService,
	XmtpTransport,
	buildDefaultTapRuntimeContext,
	loadTrustedAgentConfigFromDataDir,
} from "trusted-agents-core";
import type {
	IAgentResolver,
	TapServiceOptions,
	TransportProvider,
	XmtpTransportConfig,
} from "trusted-agents-core";
import { executeConnect } from "./commands/connect.js";
import type { ConnectResult } from "./commands/connect.js";
import { executeContacts } from "./commands/contacts.js";
import type { ContactsResult } from "./commands/contacts.js";
import { executeConversations } from "./commands/conversations.js";
import type { ConversationsResult } from "./commands/conversations.js";
import { executeInvite } from "./commands/invite.js";
import type { InviteResult } from "./commands/invite.js";
import type { NotificationAdapter } from "./notification.js";

export interface OrchestratorConfig {
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir: string;
	resolver: IAgentResolver;
	notification?: NotificationAdapter;
	transport?: TransportProvider;
	xmtp?: Omit<XmtpTransportConfig, "privateKey" | "chain" | "agentResolver">;
	calendarProvider?: ICalendarProvider;
}

export class TrustedAgentsOrchestrator {
	private readonly transport?: TransportProvider;
	private transportStarted = false;

	constructor(private readonly config: OrchestratorConfig) {
		this.transport = this.buildTransport(config);
	}

	async start(): Promise<void> {
		if (!this.transport) return;
		await this.ensureTransportStarted();
	}

	async stop(): Promise<void> {
		if (!this.transport || !this.transportStarted) return;
		await this.transport.stop?.();
		this.transportStarted = false;
	}

	async invite(expirySeconds?: number): Promise<InviteResult> {
		return executeInvite({
			privateKey: this.config.privateKey,
			agentId: this.config.agentId,
			chain: this.config.chain,
			expirySeconds,
		});
	}

	async connect(inviteUrl: string): Promise<ConnectResult> {
		if (!this.transport) {
			return {
				success: false,
				error: "No transport configured. Provide config.transport or config.xmtp.",
			};
		}

		try {
			return await executeConnect({
				inviteUrl,
				privateKey: this.config.privateKey,
				agentId: this.config.agentId,
				chain: this.config.chain,
				dataDir: this.config.dataDir,
				resolver: this.config.resolver,
				transport: this.transport,
				notify: this.config.notification
					? async (message) => {
							await this.config.notification!.notify(message);
						}
					: undefined,
			});
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Connection failed",
			};
		}
	}

	async contacts(): Promise<ContactsResult> {
		return executeContacts({ dataDir: this.config.dataDir });
	}

	async conversations(filter?: {
		withName?: string;
		conversationId?: string;
	}): Promise<ConversationsResult> {
		return executeConversations({
			dataDir: this.config.dataDir,
			withName: filter?.withName,
			conversationId: filter?.conversationId,
		});
	}

	async buildMessagingService(
		options: Omit<TapServiceOptions, "schedulingHandler"> = {},
	): Promise<TapMessagingService> {
		const config = await loadTrustedAgentConfigFromDataDir(this.config.dataDir, {
			requireAgentId: true,
		});
		const context = buildDefaultTapRuntimeContext(config, {
			resolver: this.config.resolver,
			...(this.transport ? { transport: this.transport } : {}),
		});

		const schedulingHandler = new SchedulingHandler({
			calendarProvider: this.config.calendarProvider,
			hooks: {},
		});

		return new TapMessagingService(context, {
			...options,
			schedulingHandler,
		});
	}

	private buildTransport(config: OrchestratorConfig): TransportProvider | undefined {
		if (config.transport) {
			return config.transport;
		}

		if (!config.xmtp) {
			return undefined;
		}

		const trustStore = new FileTrustStore(config.dataDir);
		return new XmtpTransport(
			{
				privateKey: config.privateKey,
				chain: config.chain,
				dbPath: `${config.dataDir}/xmtp`,
				agentResolver: config.resolver,
				...config.xmtp,
			},
			trustStore,
		);
	}

	private async ensureTransportStarted(): Promise<void> {
		if (!this.transport || this.transportStarted) {
			return;
		}
		await this.transport.start?.();
		this.transportStarted = true;
	}
}
