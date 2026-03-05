import { FileConversationLogger, generateMarkdownTranscript } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { error, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function conversationsShowCommand(id: string, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const logger = new FileConversationLogger(config.dataDir);
		const conversation = await logger.getConversation(id);

		if (!conversation) {
			error("NOT_FOUND", `Conversation not found: ${id}`, opts);
			process.exitCode = 1;
			return;
		}

		success(
			{
				id: conversation.conversationId,
				peer: conversation.peerDisplayName,
				peer_agent_id: conversation.peerAgentId,
				topic: conversation.topic,
				status: conversation.status,
				started_at: conversation.startedAt,
				last_message: conversation.lastMessageAt,
				messages: conversation.messages,
				transcript: generateMarkdownTranscript(conversation),
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
