import type { IAgentResolver } from "trusted-agents-core";
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
	sendRequest?: (endpoint: string, body: unknown) => Promise<unknown>;
	notification?: NotificationAdapter;
}

export class TrustedAgentsOrchestrator {
	private readonly approvalHandler?: ApprovalHandler;

	constructor(private readonly config: OrchestratorConfig) {
		if (config.notification) {
			this.approvalHandler = new ApprovalHandler(config.notification);
		}
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
		return executeConnect({
			inviteUrl,
			privateKey: this.config.privateKey,
			agentId: this.config.agentId,
			chain: this.config.chain,
			dataDir: this.config.dataDir,
			resolver: this.config.resolver,
			sendRequest: this.config.sendRequest,
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
}
