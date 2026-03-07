import { Command } from "commander";
import { errorCode, exitCodeForError } from "./lib/errors.js";
import { error } from "./lib/output.js";
import type { GlobalOptions } from "./types.js";

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
		.addHelpText(
			"after",
			`
Supported chains:
  base-sepolia   Base Sepolia testnet (default)
  base           Base mainnet
  taiko          Taiko mainnet
  taiko-hoodi    Taiko Hoodi testnet
  eip155:<id>    Any chain by CAIP-2 ID
`,
		)
		.action(async (cmdOpts: { privateKey?: string; chain?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { initCommand } = await import("./commands/init.js");
			await initCommand(opts, { privateKey: cmdOpts.privateKey, chain: cmdOpts.chain });
		});

	// register
	const register = program
		.command("register")
		.description("Register agent on-chain via ERC-8004")
		.addHelpText(
			"after",
			`
Capabilities are freeform strings describing what your agent can do.
Common capabilities: general-chat, scheduling, research, payments, file-sharing
You can use any string — these are advertised to peers during discovery.

Examples:
  tap register --name "Cal" --description "Scheduling assistant" --capabilities "scheduling,general-chat"
  tap register --name "Scout" --description "Web researcher" --capabilities "research,general-chat"
  tap register --name "Treasury" --description "Payment agent" --capabilities "payments,general-chat"
`,
		)
		.requiredOption("--name <name>", "Agent display name")
		.requiredOption("--description <desc>", "Agent description")
		.requiredOption("--capabilities <list>", "Comma-separated capabilities")
		.option("--uri <url>", "Pre-hosted registration file URI (skips IPFS upload)")
		.option("--pinata-jwt <token>", "Pinata JWT for IPFS upload (or set TAP_PINATA_JWT)")
		.action(
			async (cmdOpts: {
				name: string;
				description: string;
				capabilities: string;
				uri?: string;
				pinataJwt?: string;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { registerCommand } = await import("./commands/register.js");
				await registerCommand(cmdOpts, opts);
			},
		);

	register
		.command("update")
		.description("Update an existing agent's registration URI/manifest")
		.option("--name <name>", "Agent display name")
		.option("--description <desc>", "Agent description")
		.option("--capabilities <list>", "Comma-separated capabilities")
		.option("--uri <url>", "Pre-hosted registration file URI (skips IPFS upload)")
		.option("--pinata-jwt <token>", "Pinata JWT for IPFS upload")
		.action(
			async (cmdOpts: {
				name?: string;
				description?: string;
				capabilities?: string;
				uri?: string;
				pinataJwt?: string;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { registerUpdateCommand } = await import("./commands/register.js");
				await registerUpdateCommand(cmdOpts, opts);
			},
		);

	program
		.command("balance")
		.description("Show native ETH and USDC balances for this agent")
		.argument("[chain]", "Chain override (alias like base or CAIP-2 like eip155:8453)")
		.action(async (chain?: string) => {
			const opts = program.opts<GlobalOptions>();
			const { balanceCommand } = await import("./commands/balance.js");
			await balanceCommand(opts, chain);
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

	identity
		.command("resolve-self")
		.description("Resolve this agent from on-chain registry (includes capabilities)")
		.argument("[chain]", "Chain override (CAIP-2)")
		.action(async (chain?: string) => {
			const opts = program.opts<GlobalOptions>();
			const { identityResolveSelfCommand } = await import("./commands/identity-resolve.js");
			await identityResolveSelfCommand(opts, chain);
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
		.description("Send an asynchronous connection request from an invite")
		.option("--yes", "Auto-approve connection (no interactive prompt)")
		.option(
			"--request-grants-file <path>",
			"JSON file describing grants to request in the connect intent",
		)
		.option("--grant-file <path>", "JSON file describing grants to offer in the connect intent")
		.addHelpText(
			"after",
			`
Connect is asynchronous. The peer only needs to receive your request; acceptance or rejection arrives later through listen/sync.

Examples:
  tap connect "<invite-url>" --yes
  tap connect "<invite-url>" --yes --request-grants-file ./grants/request.json
  tap connect "<invite-url>" --yes --grant-file ./grants/offer.json
`,
		)
		.action(
			async (
				inviteUrl: string,
				cmdOpts: { yes?: boolean; requestGrantsFile?: string; grantFile?: string },
			) => {
				const opts = program.opts<GlobalOptions>();
				const { connectCommand } = await import("./commands/connect.js");
				await connectCommand(inviteUrl, !!cmdOpts.yes, cmdOpts, opts);
			},
		);

	const permissions = program.command("permissions").description("Manage directional grants");

	permissions
		.command("show [peer]")
		.description("Show grants for one peer or list grant counts for all peers")
		.action(async (peer?: string) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsShowCommand } = await import("./commands/permissions-show.js");
			await permissionsShowCommand(peer, opts);
		});

	permissions
		.command("grant <peer>")
		.description("Publish the grants you give to a peer from a JSON file")
		.requiredOption("--file <path>", "Path to a JSON grant file")
		.option("--note <text>", "Optional note recorded in the ledger")
		.action(async (peer: string, cmdOpts: { file: string; note?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsGrantCommand } = await import("./commands/permissions-grant.js");
			await permissionsGrantCommand(peer, cmdOpts.file, opts, { note: cmdOpts.note });
		});

	permissions
		.command("request <peer>")
		.description("Request that a peer grants you permissions from a JSON file")
		.requiredOption("--file <path>", "Path to a JSON grant file")
		.option("--note <text>", "Optional note included with the request")
		.action(async (peer: string, cmdOpts: { file: string; note?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsRequestCommand } = await import("./commands/permissions-request.js");
			await permissionsRequestCommand(peer, cmdOpts.file, opts, { note: cmdOpts.note });
		});

	permissions
		.command("revoke <peer>")
		.description("Revoke one grant you previously published to a peer")
		.requiredOption("--grant-id <id>", "Grant ID to revoke")
		.option("--note <text>", "Optional note recorded in the ledger")
		.action(async (peer: string, cmdOpts: { grantId: string; note?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsRevokeCommand } = await import("./commands/permissions-revoke.js");
			await permissionsRevokeCommand(peer, cmdOpts.grantId, opts, { note: cmdOpts.note });
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
		.option("--scope <scope>", "Semantic message scope", "general-chat")
		.action(async (peer: string, text: string, cmdOpts: { scope?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { messageSendCommand } = await import("./commands/message-send.js");
			await messageSendCommand(peer, text, opts, { scope: cmdOpts.scope });
		});

	message
		.command("request-funds <peer>")
		.description("Request native ETH or USDC from a connected peer")
		.requiredOption("--asset <asset>", "Asset to request: native or usdc")
		.requiredOption("--amount <amount>", "Human-readable amount to request")
		.option("--chain <chain>", "Chain alias or CAIP-2 ID (defaults to local config chain)")
		.option("--to <address>", "Recipient address (defaults to this agent wallet)")
		.option("--note <text>", "Optional note included with the request")
		.action(
			async (
				peer: string,
				cmdOpts: { asset: string; amount: string; chain?: string; to?: string; note?: string },
			) => {
				const opts = program.opts<GlobalOptions>();
				const { messageRequestFundsCommand } = await import("./commands/message-request-funds.js");
				await messageRequestFundsCommand(peer, cmdOpts, opts);
			},
		);

	message
		.command("listen")
		.description("Stream incoming messages and process results (long-running)")
		.option("--yes", "Auto-accept incoming connection requests")
		.option("--yes-actions", "Auto-approve incoming action requests without interactive review")
		.action(async (cmdOpts: { yes?: boolean; yesActions?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { messageListenCommand } = await import("./commands/message-listen.js");
			await messageListenCommand(opts, { yes: cmdOpts.yes, yesActions: cmdOpts.yesActions });
		});

	message
		.command("sync")
		.description("Reconcile missed XMTP messages and process queued work once")
		.option("--yes", "Auto-accept incoming connection requests during reconciliation")
		.option("--yes-actions", "Auto-approve incoming action requests during reconciliation")
		.action(async (cmdOpts: { yes?: boolean; yesActions?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { messageSyncCommand } = await import("./commands/message-sync.js");
			await messageSyncCommand(opts, { yes: cmdOpts.yes, yesActions: cmdOpts.yesActions });
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
