import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { error, success, verbose } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function messageSendCommand(
	peer: string,
	text: string,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);

		// Resolve peer by name or agentId
		const contacts = await ctx.trustStore.getContacts();

		const agentIdNum = Number.parseInt(peer, 10);
		const contact = contacts.find(
			(c) =>
				c.peerDisplayName.toLowerCase() === peer.toLowerCase() ||
				(!Number.isNaN(agentIdNum) && c.peerAgentId === agentIdNum),
		);

		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 1;
			return;
		}

		verbose(`Sending message to ${contact.peerDisplayName} (#${contact.peerAgentId})...`, opts);

		await ctx.transport.start?.();
		try {
			const request = {
				jsonrpc: "2.0" as const,
				id: crypto.randomUUID(),
				method: "message/send",
				params: {
					message: {
						messageId: crypto.randomUUID(),
						role: "user" as const,
						parts: [{ kind: "text" as const, text }],
					},
				},
			};

			const response = await ctx.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});

			success(
				{
					sent: true,
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					response,
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
