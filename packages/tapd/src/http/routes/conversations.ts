import type { ConversationLog, IConversationLogger } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface ConversationsRoutes {
	list: RouteHandler<unknown, ConversationLog[]>;
	get: RouteHandler<unknown, ConversationLog | null>;
	markRead: RouteHandler<unknown, { ok: true }>;
}

export function createConversationsRoutes(logger: IConversationLogger): ConversationsRoutes {
	return {
		list: async () => {
			const all = await logger.listConversations();
			return [...all].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
		},
		get: async (params) => {
			const id = params.id;
			if (!id) return null;
			return await logger.getConversation(id);
		},
		markRead: async (params) => {
			const id = params.id;
			if (id) {
				await logger.markRead(id, new Date().toISOString());
			}
			return { ok: true };
		},
	};
}
