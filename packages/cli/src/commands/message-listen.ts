import { CONNECTION_REQUEST, handleConnectionRequest } from "trusted-agents-core";
import type { ResolvedAgent } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import {
	appendConversationLog,
	findUniqueContactForAgentId,
} from "../lib/message-conversations.js";
import { error, info } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";
import type { GlobalOptions } from "../types.js";

export async function messageListenCommand(
	opts: GlobalOptions,
	cmdOpts?: { yes?: boolean },
): Promise<void> {
	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const autoApprove = cmdOpts?.yes ?? false;

		info("Listening for incoming messages... (Ctrl+C to stop)", opts);

		ctx.transport.onMessage(async (from, message) => {
			if (message.method === CONNECTION_REQUEST) {
				return handleConnectionRequest({
					message,
					resolver: ctx.resolver,
					trustStore: ctx.trustStore,
					ownAgent: { agentId: config.agentId, chain: config.chain },
					approve: async (peer: ResolvedAgent) => {
						if (autoApprove) {
							info(
								`Auto-accepting connection from ${peer.registrationFile.name} (#${peer.agentId})`,
								opts,
							);
							return true;
						}
						info(
							`Connection request from ${peer.registrationFile.name} (#${peer.agentId}) on ${peer.chain}`,
							opts,
						);
						info(`Capabilities: ${peer.capabilities.join(", ")}`, opts);
						return promptYesNo("Accept? [y/N] ");
					},
				});
			}

			const contacts = await ctx.trustStore.getContacts();
			const contact = findUniqueContactForAgentId(contacts, from);
			if (contact) {
				void appendConversationLog(ctx.conversationLogger, contact, message, "incoming").catch(
					() => {},
				);
				void ctx.trustStore.touchContact(contact.connectionId).catch(() => {});
			}

			// All other messages: log to stdout
			const line = JSON.stringify({
				timestamp: new Date().toISOString(),
				from,
				method: message.method,
				id: message.id,
				params: message.params,
			});
			process.stdout.write(`${line}\n`);

			return {
				jsonrpc: "2.0" as const,
				id: message.id,
				result: { received: true },
			};
		});

		await ctx.transport.start?.();

		// Handle graceful shutdown
		const shutdown = async () => {
			info("\nShutting down...", opts);
			await ctx.transport.stop?.();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		// Keep alive
		await new Promise(() => {});
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
