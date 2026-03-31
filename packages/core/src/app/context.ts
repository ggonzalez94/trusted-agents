import type { IConversationLogger } from "../conversation/logger.js";
import type { PermissionGrant } from "../permissions/types.js";
import type { Contact } from "../trust/types.js";
import { FileAppStorage } from "./storage.js";
import type { TapActionContext, TapApp } from "./types.js";

export interface BuildActionContextDeps {
	config: {
		agentId: number;
		chain: string;
		dataDir: string;
	};
	agentAddress: `0x${string}`;
	contact: Contact;
	payload: Record<string, unknown>;
	text?: string;
	app: TapApp;
	reply: (text: string) => Promise<void>;
	sendToPeer: (peerId: number, text: string) => Promise<void>;
	requestPayment: (params: {
		asset: string;
		amount: string;
		chain: string;
		toAddress: `0x${string}`;
		note?: string;
	}) => Promise<{ requestId: string }>;
	executeTransfer: (params: {
		asset: string;
		amount: string;
		chain: string;
		toAddress: `0x${string}`;
		note?: string;
	}) => Promise<{ txHash: `0x${string}` }>;
	emitEvent: (event: { type: string; summary: string; data?: Record<string, unknown> }) => void;
	conversationLogger: IConversationLogger;
	conversationId: string;
	extensions?: Record<string, unknown>;
}

function filterGrantsByScopes(grants: PermissionGrant[], scopes: string[]): PermissionGrant[] {
	if (scopes.length === 0) {
		return grants;
	}
	return grants.filter((g) => scopes.includes(g.scope));
}

export function buildActionContext(deps: BuildActionContextDeps): TapActionContext {
	const grantScopes = deps.app.grantScopes ?? [];
	const allGrantsFromPeer = deps.contact.permissions.grantedByPeer.grants;
	const allGrantsToPeer = deps.contact.permissions.grantedByMe.grants;

	return {
		self: {
			agentId: deps.config.agentId,
			chain: deps.config.chain,
			address: deps.agentAddress,
		},
		peer: {
			contact: deps.contact,
			grantsFromPeer: filterGrantsByScopes(allGrantsFromPeer, grantScopes),
			grantsToPeer: filterGrantsByScopes(allGrantsToPeer, grantScopes),
		},
		payload: deps.payload,
		text: deps.text,
		messaging: {
			reply: deps.reply,
			send: deps.sendToPeer,
		},
		payments: {
			request: deps.requestPayment,
			execute: deps.executeTransfer,
		},
		storage: new FileAppStorage(deps.config.dataDir, deps.app.id),
		events: {
			emit: deps.emitEvent,
		},
		log: {
			append: async (entry) => {
				await deps.conversationLogger.logMessage(deps.conversationId, {
					messageId: `app-${deps.app.id}-${Date.now()}`,
					timestamp: new Date().toISOString(),
					direction: entry.direction === "inbound" ? "incoming" : "outgoing",
					scope: deps.app.id,
					content: entry.text,
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				});
			},
		},
		extensions: deps.extensions ?? {},
	};
}
