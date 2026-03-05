import { Command } from "commander";
import type { GlobalOptions } from "./types.js";
import { error } from "./lib/output.js";
import { exitCodeForError, errorCode } from "./lib/errors.js";

export function createCli(): Command {
	const program = new Command();

	program
		.name("tap")
		.description("Trusted Agents Protocol CLI")
		.version("0.1.0")
		.option("--json", "Force JSON output")
		.option("--plain", "Force plain text output")
		.option("--config <path>", "Override config file path")
		.option("--data-dir <path>", "Override data directory")
		.option("--chain <caip2>", "Override chain (e.g. eip155:8453)")
		.option("-v, --verbose", "Verbose logging to stderr")
		.option("-q, --quiet", "Suppress non-essential output");

	// init
	program
		.command("init")
		.description("First-time setup wizard")
		.option("--private-key <hex>", "Import an existing private key instead of generating one")
		.option("--chain <name>", "Chain to register on (alias or CAIP-2)", "base-sepolia")
		.addHelpText("after", `
Supported chains:
  base-sepolia   Base Sepolia testnet (default)
  base           Base mainnet
  taiko          Taiko mainnet
  taiko-hoodi    Taiko Hoodi testnet
  eip155:<id>    Any chain by CAIP-2 ID
`)
		.action(async (cmdOpts: { privateKey?: string; chain?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { initCommand } = await import("./commands/init.js");
			await initCommand(opts, { privateKey: cmdOpts.privateKey, chain: cmdOpts.chain });
		});

	// register
	const register = program
		.command("register")
		.description("Register agent on-chain via ERC-8004")
		.addHelpText("after", `
Capabilities are freeform strings describing what your agent can do.
Common capabilities: general-chat, scheduling, research, purchases, file-sharing
You can use any string — these are advertised to peers during discovery.

Examples:
  tap register --name "Cal" --description "Scheduling assistant" --capabilities "scheduling,general-chat"
  tap register --name "Scout" --description "Web researcher" --capabilities "research,general-chat"
  tap register --name "Shopper" --description "Purchase agent" --capabilities "purchases,general-chat"
`)
		.requiredOption("--name <name>", "Agent display name")
		.requiredOption("--description <desc>", "Agent description")
		.requiredOption("--capabilities <list>", "Comma-separated capabilities")
		.option("--uri <url>", "Pre-hosted registration file URI (skips IPFS upload)")
		.option("--pinata-jwt <token>", "Pinata JWT for IPFS upload (or set TAP_PINATA_JWT)")
		.action(async (cmdOpts: { name: string; description: string; capabilities: string; uri?: string; pinataJwt?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { registerCommand } = await import("./commands/register.js");
			await registerCommand(cmdOpts, opts);
		});

	register
		.command("update")
		.description("Update an existing agent's registration file")
		.requiredOption("--name <name>", "Agent display name")
		.option("--description <desc>", "Agent description")
		.option("--capabilities <list>", "Comma-separated capabilities")
		.option("--uri <url>", "Pre-hosted registration file URI (skips IPFS upload)")
		.option("--pinata-jwt <token>", "Pinata JWT for IPFS upload")
		.action(async (cmdOpts: { name: string; description?: string; capabilities?: string; uri?: string; pinataJwt?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { registerUpdateCommand } = await import("./commands/register.js");
			await registerUpdateCommand(cmdOpts, opts);
		});

	// config
	const config = program.command("config").description("Manage configuration");

	config
		.command("show")
		.description("Print resolved config (secrets redacted)")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { configShowCommand } = await import("./commands/config-show.js");
			await configShowCommand(opts);
		});

	config
		.command("set <key> <value>")
		.description("Set a config value")
		.action(async (key: string, value: string) => {
			const opts = program.opts<GlobalOptions>();
			const { configSetCommand } = await import("./commands/config-set.js");
			await configSetCommand(key, value, opts);
		});

	// identity
	const identity = program.command("identity").description("Manage agent identity");

	identity
		.command("show")
		.description("Show this agent's identity")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { identityShowCommand } = await import("./commands/identity-show.js");
			await identityShowCommand(opts);
		});

	identity
		.command("resolve <agentId>")
		.description("Resolve a peer from on-chain registry")
		.argument("[chain]", "Chain override (CAIP-2)")
		.action(async (agentId: string, chain?: string) => {
			const opts = program.opts<GlobalOptions>();
			const parsed = Number.parseInt(agentId, 10);
			if (Number.isNaN(parsed) || parsed < 0) {
				const { error: outputError } = await import("./lib/output.js");
				outputError("VALIDATION_ERROR", `Invalid agent ID: ${agentId}`, opts);
				process.exitCode = 2;
				return;
			}
			const { identityResolveCommand } = await import("./commands/identity-resolve.js");
			await identityResolveCommand(parsed, opts, chain);
		});

	// invite
	const invite = program.command("invite").description("Manage invites");

	invite
		.command("create")
		.description("Generate invite link")
		.option("--expiry <seconds>", "Expiry in seconds", "86400")
		.action(async (cmdOpts: { expiry: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { inviteCreateCommand } = await import("./commands/invite-create.js");
			await inviteCreateCommand(Number.parseInt(cmdOpts.expiry, 10), opts);
		});

	invite
		.command("list")
		.description("Show pending invites")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { inviteListCommand } = await import("./commands/invite-list.js");
			await inviteListCommand(opts);
		});

	// connect
	program
		.command("connect <invite-url>")
		.description("Accept invite, establish connection")
		.option("--yes", "Auto-approve connection (no interactive prompt)")
		.action(async (inviteUrl: string, cmdOpts: { yes?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { connectCommand } = await import("./commands/connect.js");
			await connectCommand(inviteUrl, !!cmdOpts.yes, opts);
		});

	// contacts
	const contacts = program.command("contacts").description("Manage contacts");

	contacts
		.command("list")
		.description("List all contacts")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { contactsListCommand } = await import("./commands/contacts-list.js");
			await contactsListCommand(opts);
		});

	contacts
		.command("show <name-or-id>")
		.description("Detail for one contact")
		.action(async (nameOrId: string) => {
			const opts = program.opts<GlobalOptions>();
			const { contactsShowCommand } = await import("./commands/contacts-show.js");
			await contactsShowCommand(nameOrId, opts);
		});

	contacts
		.command("remove <connectionId>")
		.description("Remove a contact")
		.action(async (connectionId: string) => {
			const opts = program.opts<GlobalOptions>();
			const { contactsRemoveCommand } = await import("./commands/contacts-remove.js");
			await contactsRemoveCommand(connectionId, opts);
		});

	// message
	const message = program.command("message").description("Send and receive messages");

	message
		.command("send <peer> <text>")
		.description("Send message to connected peer")
		.action(async (peer: string, text: string) => {
			const opts = program.opts<GlobalOptions>();
			const { messageSendCommand } = await import("./commands/message-send.js");
			await messageSendCommand(peer, text, opts);
		});

	message
		.command("listen")
		.description("Stream incoming messages (long-running)")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { messageListenCommand } = await import("./commands/message-listen.js");
			await messageListenCommand(opts);
		});

	// conversations
	const conversations = program.command("conversations").description("View conversation history");

	conversations
		.command("list")
		.description("Conversation summaries")
		.option("--with <name>", "Filter by peer name")
		.action(async (cmdOpts: { with?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { conversationsListCommand } = await import("./commands/conversations-list.js");
			await conversationsListCommand(opts, cmdOpts.with);
		});

	conversations
		.command("show <id>")
		.description("Full transcript")
		.action(async (id: string) => {
			const opts = program.opts<GlobalOptions>();
			const { conversationsShowCommand } = await import("./commands/conversations-show.js");
			await conversationsShowCommand(id, opts);
		});

	// Error handling
	program.exitOverride();
	program.configureOutput({
		writeErr: (str) => {
			if (!str.includes("(outputHelp)")) {
				process.stderr.write(str);
			}
		},
	});

	program.hook("postAction", () => {
		// Commands handle their own exit
	});

	process.on("uncaughtException", (err) => {
		const opts = program.opts<GlobalOptions>();
		error(errorCode(err), err.message, opts);
		process.exitCode = exitCodeForError(err);
	});

	return program;
}
