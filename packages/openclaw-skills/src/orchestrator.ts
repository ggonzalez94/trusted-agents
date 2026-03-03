import type { IAgentResolver } from "trusted-agents-core";
import { executeConnect } from "./commands/connect.js";
import type { ConnectResult } from "./commands/connect.js";
import { executeContacts } from "./commands/contacts.js";
import type { ContactsResult } from "./commands/contacts.js";
import { executeConversations } from "./commands/conversations.js";
import type { ConversationsResult } from "./commands/conversations.js";
import { executeInvite } from "./commands/invite.js";
import type { InviteResult } from "./commands/invite.js";

export interface OrchestratorConfig {
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir: string;
	resolver: IAgentResolver;
	sendRequest?: (endpoint: string, body: unknown) => Promise<unknown>;
}

export class TrustedAgentsOrchestrator {
	constructor(private readonly config: OrchestratorConfig) {}

	async invite(expirySeconds?: number): Promise<InviteResult> {
		return executeInvite({
			privateKey: this.config.privateKey,
			agentId: this.config.agentId,
			chain: this.config.chain,
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
		});
	}

	async contacts(): Promise<ContactsResult> {
		return executeContacts({ dataDir: this.config.dataDir });
	}

	async conversations(filter?: { withName?: string }): Promise<ConversationsResult> {
		return executeConversations({
			dataDir: this.config.dataDir,
			withName: filter?.withName,
		});
	}
}
