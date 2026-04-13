export interface CommandMetadata {
	auth?: string[];
	examples?: string[];
	mutates?: boolean;
	notes?: string[];
	supportsDryRun?: boolean;
	supportsFields?: boolean;
	supportsStdin?: boolean;
}

export const COMMAND_METADATA: Record<string, CommandMetadata> = {
	tap: {
		examples: [
			"tap schema",
			"tap contacts list --output json --select name,status",
			"tap transfer --to 0xabc... --asset usdc --amount 5 --dry-run",
		],
		notes: [
			"Default output is JSON. Use --output text for human-readable tables and summaries.",
			"Use `tap schema <command>` or `tap <command> --describe` to inspect the runtime contract.",
		],
	},
	"tap install": {
		examples: [
			"tap install",
			"tap install --runtime codex",
			"tap install --runtime openclaw",
			"tap install --channel beta --runtime openclaw",
			"tap install --version 0.2.0-beta.1 --runtime openclaw",
		],
	},
	"tap remove": {
		examples: ["tap remove --dry-run", "tap remove --unsafe-wipe-data-dir --yes"],
		mutates: true,
		supportsDryRun: true,
	},
	"tap init": {
		examples: [
			"tap init --chain base --non-interactive",
			"tap init --chain taiko --wallet team-agent",
		],
		mutates: true,
	},
	"tap migrate-wallet": {
		examples: [
			"tap migrate-wallet --non-interactive",
			"tap migrate-wallet --passphrase secret-passphrase",
		],
		mutates: true,
	},
	"tap register": {
		examples: [
			'tap register create --name Cal --description "Scheduling agent" --capabilities scheduling,general-chat',
			"tap register update --capabilities transfer,research,general-chat",
		],
		mutates: true,
	},
	"tap register create": {
		examples: [
			'tap register create --name Cal --description "Scheduling agent" --capabilities scheduling,general-chat',
			'tap register create --name Scout --description "Research agent" --capabilities research,general-chat --uri https://example.com/registration.json',
		],
		mutates: true,
	},
	"tap register update": {
		examples: [
			'tap register update --description "Updated description"',
			"tap register update --capabilities transfer,research,general-chat",
		],
		mutates: true,
	},
	"tap balance": {
		examples: [
			"tap balance",
			"tap balance eip155:8453",
			"tap balance --output json --select native_balance_eth,usdc_balance",
		],
		auth: ["ows"],
		supportsFields: true,
	},
	"tap transfer": {
		examples: [
			"tap transfer --to 0x1111111111111111111111111111111111111111 --asset usdc --amount 5 --dry-run",
			"tap transfer --to 0x1111111111111111111111111111111111111111 --asset native --amount 0.01 --yes",
		],
		auth: ["ows"],
		mutates: true,
		supportsDryRun: true,
	},
	"tap config": {
		examples: ["tap config show", "tap config set execution.mode eip7702"],
	},
	"tap config show": {
		examples: [
			"tap config show",
			"tap config show --output json --select agent_id,chain,ows.wallet",
		],
		supportsFields: true,
	},
	"tap config set": {
		examples: ["tap config set execution.mode eip7702", "tap config set ipfs.provider tack"],
		mutates: true,
	},
	"tap identity": {
		examples: ["tap identity show", "tap identity resolve 42 eip155:8453"],
	},
	"tap identity show": {
		examples: [
			"tap identity show",
			"tap identity show --output json --select agent_id,chain,address",
		],
		supportsFields: true,
	},
	"tap identity resolve": {
		examples: ["tap identity resolve 42", "tap identity resolve 42 eip155:8453"],
		supportsFields: true,
	},
	"tap identity resolve-self": {
		examples: ["tap identity resolve-self", "tap identity resolve-self eip155:8453"],
		supportsFields: true,
	},
	"tap invite": {
		examples: ["tap invite create", "tap invite create --expiry 3600"],
	},
	"tap invite create": {
		examples: ["tap invite create", "tap invite create --expiry 3600"],
		mutates: true,
	},
	"tap connect": {
		examples: [
			'tap connect "<invite-url>" --dry-run',
			'tap connect "<invite-url>" --yes --wait 60',
		],
		mutates: true,
		supportsDryRun: true,
	},
	"tap permissions": {
		examples: [
			"tap permissions show",
			'tap permissions grant Worker --file ./grants.json --note "weekly budget"',
		],
	},
	"tap permissions show": {
		examples: [
			"tap permissions show",
			"tap permissions show Worker --output json --select granted_by_me,granted_by_peer",
		],
		supportsFields: true,
	},
	"tap permissions grant": {
		examples: [
			"tap permissions grant Worker --file ./grants.json --dry-run",
			"cat grants.json | tap permissions grant Worker --file -",
		],
		mutates: true,
		supportsDryRun: true,
		supportsStdin: true,
	},
	"tap permissions request": {
		examples: [
			"tap permissions request Treasury --file ./request.json --dry-run",
			"cat request.json | tap permissions request Treasury --file -",
		],
		mutates: true,
		supportsDryRun: true,
		supportsStdin: true,
	},
	"tap permissions revoke": {
		examples: [
			"tap permissions revoke Worker --grant-id weekly-usdc --dry-run",
			'tap permissions revoke Worker --grant-id weekly-usdc --note "budget paused"',
		],
		mutates: true,
		supportsDryRun: true,
	},
	"tap contacts": {
		examples: ["tap contacts list", "tap contacts show Worker"],
	},
	"tap contacts list": {
		examples: [
			"tap contacts list",
			"tap contacts list --output json --select name,status --limit 10",
		],
		supportsFields: true,
	},
	"tap contacts show": {
		examples: [
			"tap contacts show Worker",
			"tap contacts show conn_123 --output json --select name,status,granted_by_peer",
		],
		supportsFields: true,
	},
	"tap contacts remove": {
		examples: ["tap contacts remove conn_123"],
		mutates: true,
	},
	"tap message": {
		examples: ['tap message send Worker "hello"', "tap message sync"],
	},
	"tap message send": {
		examples: [
			'tap message send Worker "hello" --scope general-chat',
			'tap message send Worker "status update" --scope research',
		],
		mutates: true,
	},
	"tap message request-funds": {
		examples: [
			"tap message request-funds Treasury --asset usdc --amount 5 --dry-run",
			'tap message request-funds Treasury --asset native --amount 0.01 --note "gas refill"',
		],
		mutates: true,
		supportsDryRun: true,
	},
	"tap message listen": {
		examples: ["tap message listen"],
	},
	"tap message sync": {
		examples: ["tap message sync"],
		mutates: true,
	},
	"tap message request-meeting": {
		examples: [
			'tap message request-meeting Scheduler --title "Weekly sync" --preferred 2026-03-27T15:00:00Z --dry-run',
			'tap message request-meeting Scheduler --title Lunch --duration 90 --location "Cafe"',
		],
		mutates: true,
		supportsDryRun: true,
	},
	"tap message respond-meeting": {
		examples: [
			"tap message respond-meeting sched_123 --accept --dry-run",
			'tap message respond-meeting sched_123 --reject --reason "calendar conflict"',
		],
		mutates: true,
		supportsDryRun: true,
	},
	"tap message cancel-meeting": {
		examples: [
			"tap message cancel-meeting sched_123 --dry-run",
			'tap message cancel-meeting sched_123 --reason "no longer needed"',
		],
		mutates: true,
		supportsDryRun: true,
	},
	"tap calendar": {
		examples: ["tap calendar setup", "tap calendar check"],
	},
	"tap calendar setup": {
		examples: ["tap calendar setup", "tap calendar setup --provider google"],
		mutates: true,
	},
	"tap calendar check": {
		examples: ["tap calendar check"],
		supportsFields: true,
	},
	"tap conversations": {
		examples: ["tap conversations list", "tap conversations show conv_123"],
	},
	"tap conversations list": {
		examples: [
			"tap conversations list",
			"tap conversations list --with Worker --output json --select id,peer,last_message",
		],
		supportsFields: true,
	},
	"tap conversations show": {
		examples: [
			"tap conversations show conv_123",
			"tap conversations show conv_123 --output ndjson",
		],
		supportsFields: true,
	},
	"tap schema": {
		examples: ["tap schema", "tap schema contacts list", "tap contacts list --describe"],
		supportsFields: true,
	},
};

export function formatMetadataHelp(path: string): string | undefined {
	const metadata = COMMAND_METADATA[path];
	if (!metadata) {
		return undefined;
	}

	const lines: string[] = [];
	if (metadata.examples && metadata.examples.length > 0) {
		lines.push("Examples:");
		for (const example of metadata.examples) {
			lines.push(`  ${example}`);
		}
	}

	if (metadata.notes && metadata.notes.length > 0) {
		lines.push("", "Agent Notes:");
		for (const note of metadata.notes) {
			lines.push(`  ${note}`);
		}
	}

	return lines.length > 0 ? `\n${lines.join("\n")}\n` : undefined;
}
