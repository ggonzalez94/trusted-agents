import { FileTrustStore, XmtpTransport } from "trusted-agents-core";
import type {
	IAgentResolver,
	TransportHandlers,
	TransportProvider,
	XmtpTransportConfig,
} from "trusted-agents-core";
import { ApprovalHandler } from "./approval.js";
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
}

export class TrustedAgentsOrchestrator {
	private readonly approvalHandler?: ApprovalHandler;
	private readonly transport?: TransportProvider;
	private transportStarted = false;

	constructor(private readonly config: OrchestratorConfig) {
		if (config.notification) {
			this.approvalHandler = new ApprovalHandler(config.notification);
		}
		this.transport = this.buildTransport(config);
	}

	async start(options?: {
		handlers?: TransportHandlers;
	}): Promise<void> {
		if (!this.transport) return;
		if (options?.handlers) {
			this.transport.setHandlers(options.handlers);
		}
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
			dataDir: this.config.dataDir,
			expirySeconds,
		});
	}

	async connect(inviteUrl: string): Promise<ConnectResult> {
		if (this.transport) {
			await this.ensureTransportStarted();
		}

		return executeConnect({
			inviteUrl,
			privateKey: this.config.privateKey,
			agentId: this.config.agentId,
			chain: this.config.chain,
			dataDir: this.config.dataDir,
			resolver: this.config.resolver,
			transport: this.transport!,
			approveConnection: this.approvalHandler
				? async (details) =>
						this.approvalHandler!.requestApproval({
							type: "connection",
							description: `Connect to ${details.peerName} (#${details.peerAgentId})`,
							details: {
								peerName: details.peerName,
								peerAgentId: details.peerAgentId,
								chain: details.chain,
								capabilities: details.capabilities.join(", "),
							},
						})
				: undefined,
			notify: this.config.notification
				? async (message) => {
						await this.config.notification!.notify(message);
					}
				: undefined,
		});
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
