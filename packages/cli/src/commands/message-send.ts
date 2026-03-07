import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import {
	appendConversationLog,
	buildOutgoingMessageRequest,
	findContactForPeer,
} from "../lib/message-conversations.js";
import { error, success, verbose } from "../lib/output.js";
import { DEFAULT_MESSAGE_SCOPE } from "../lib/scopes.js";
import type { GlobalOptions } from "../types.js";

export async function messageSendCommand(
	peer: string,
	text: string,
	opts: GlobalOptions,
	cmdOpts?: { scope?: string },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);

		// Resolve peer by name or agentId
		const contacts = await ctx.trustStore.getContacts();
		const contact = findContactForPeer(contacts, peer);

		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 1;
			return;
		}

		const scope = cmdOpts?.scope?.trim() || DEFAULT_MESSAGE_SCOPE;

		verbose(`Sending message to ${contact.peerDisplayName} (#${contact.peerAgentId})...`, opts);

		await ctx.transport.start?.();
		try {
			const request = buildOutgoingMessageRequest(contact, text, scope);
			const messageTimestamp = new Date().toISOString();

			let response: Awaited<ReturnType<typeof ctx.transport.send>>;
			try {
				response = await ctx.transport.send(contact.peerAgentId, request, {
					peerAddress: contact.peerAgentAddress,
				});
			} catch (err) {
				if (err instanceof Error && err.message.startsWith("Response timeout for message ")) {
					void appendConversationLog(
						ctx.conversationLogger,
						contact,
						request,
						"outgoing",
						messageTimestamp,
					).catch(() => {});
					void ctx.trustStore.touchContact(contact.connectionId).catch(() => {});
				}
				throw err;
			}

			await appendConversationLog(
				ctx.conversationLogger,
				contact,
				request,
				"outgoing",
				messageTimestamp,
			);
			await ctx.trustStore.touchContact(contact.connectionId);

			success(
				{
					sent: true,
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					scope,
					receipt: response,
				},
				opts,
				startTime,
			);
		} finally {
			await ctx.transport.stop?.();
		}
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
