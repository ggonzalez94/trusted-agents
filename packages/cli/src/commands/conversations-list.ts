import { SqliteConversationLogger, migrateFileLogsToSqlite } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function conversationsListCommand(
	opts: GlobalOptions,
	withName?: string,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const logger = new SqliteConversationLogger(config.dataDir);
		await migrateFileLogsToSqlite(config.dataDir, logger);
		let conversations = await logger.listConversations();

		if (withName) {
			conversations = conversations.filter(
				(c) => c.peerDisplayName.toLowerCase() === withName.toLowerCase(),
			);
		}

		const formatted = conversations.map((c) => ({
			id: c.conversationId,
			peer: c.peerDisplayName,
			topic: c.topic ?? "",
			messages: c.messages?.length ?? 0,
			status: c.status,
			last_message: c.lastMessageAt,
		}));

		success({ conversations: formatted }, opts, startTime);
		logger.close();
	} catch (err) {
		handleCommandError(err, opts);
	}
}
