import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
	type Contact,
	type ConversationLog,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	type RequestJournalEntry,
	type TransportOwnerInfo,
	TransportOwnerLock,
	isProcessAlive,
} from "trusted-agents-core";
import YAML from "yaml";
import { readHermesTapDaemonState } from "../hermes/client.js";
import {
	type TapHermesDaemonState,
	type TapHermesPluginConfig,
	loadTapHermesPluginConfig,
	resolveHermesHome,
} from "../hermes/config.js";
import {
	resolveConfigPath,
	resolveDataDir,
	validateConfigPathInDataDir,
} from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

const STUCK_CONNECTING_THRESHOLD_MINUTES = 5;

type HostMode =
	| "not-initialized"
	| "config-invalid"
	| "not-registered"
	| "idle"
	| "cli-listener"
	| "cli-transient"
	| "hermes-managed"
	| "openclaw-managed"
	| "unknown-owner";

type ConfigState =
	| { kind: "missing" }
	| { kind: "invalid"; error: string }
	| { kind: "parsed"; agentId: number | null; chain: string | null };

interface StatusPayload {
	data_dir: string;
	config: {
		exists: boolean;
		valid: boolean;
		agent_id: number | null;
		chain: string | null;
		registered: boolean;
	};
	host: {
		mode: HostMode;
		transport_owner:
			| (TransportOwnerInfo & {
					alive: boolean;
			  })
			| null;
		hermes: HermesStatus | null;
	};
	contacts: {
		total: number;
		active: number;
		connecting: number;
		oldest_connecting: {
			peer: string;
			established_at: string;
			age_minutes: number;
		} | null;
	};
	messages: {
		inbound_count: number;
		outbound_count: number;
		last_inbound: MessageSummary | null;
		last_outbound: MessageSummary | null;
	};
	journal: {
		inbound_pending: number;
		outbound_pending: number;
		queued_commands: number;
		oldest_pending: {
			request_id: string;
			method: string;
			direction: "inbound" | "outbound";
			age_minutes: number;
			last_error?: string;
		} | null;
	};
	warnings: string[];
}

interface HermesStatus {
	installed: boolean;
	daemon_running: boolean;
	daemon_pid: number | null;
	gateway_pid: number | null;
	manages_this_data_dir: boolean;
	configured_identities: string[];
}

interface MessageSummary {
	peer: string;
	peer_agent_id: number;
	at: string;
}

interface StatusFlags {
	hermesHome?: string;
}

export async function statusCommand(flags: StatusFlags, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);
		// Prevent an internally inconsistent status where --data-dir points at
		// agent A but --config reads from agent B.
		validateConfigPathInDataDir(opts, configPath, dataDir);

		const configState = readConfigState(configPath);
		const registered =
			configState.kind === "parsed" && configState.agentId !== null && configState.agentId >= 0;

		const ownerInspector = new TransportOwnerLock(dataDir, "tap:status");
		const rawOwner = await ownerInspector.inspect();
		const ownerAlive = rawOwner ? isProcessAlive(rawOwner.pid) : false;
		const transportOwner = rawOwner ? { ...rawOwner, alive: ownerAlive } : null;

		const contacts = await readContacts(dataDir);
		const journalEntries = await readJournal(dataDir);
		const conversations = await readConversations(dataDir);
		const hermes = await readHermesStatus(flags.hermesHome, dataDir);

		const mode = detectMode({
			configState,
			registered,
			transportOwner,
		});

		const contactsSummary = summarizeContacts(contacts);
		const messages = summarizeMessages(conversations);
		const journalSummary = summarizeJournal(journalEntries);

		const warnings = buildWarnings({
			configState,
			registered,
			transportOwner,
			contactsSummary,
			journalSummary,
			hermes,
		});

		const payload: StatusPayload = {
			data_dir: dataDir,
			config: {
				exists: configState.kind !== "missing",
				valid: configState.kind === "parsed",
				agent_id: configState.kind === "parsed" ? configState.agentId : null,
				chain: configState.kind === "parsed" ? configState.chain : null,
				registered,
			},
			host: {
				mode,
				transport_owner: transportOwner,
				hermes,
			},
			contacts: contactsSummary,
			messages,
			journal: journalSummary,
			warnings,
		};

		success(payload, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

function readConfigState(configPath: string): ConfigState {
	if (!existsSync(configPath)) {
		return { kind: "missing" };
	}

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		return { kind: "invalid", error: err instanceof Error ? err.message : String(err) };
	}

	let parsed: unknown;
	try {
		parsed = YAML.parse(raw);
	} catch (err) {
		return { kind: "invalid", error: err instanceof Error ? err.message : String(err) };
	}

	if (parsed === null || parsed === undefined) {
		// Empty file. Treat as present-but-unusable so we don't fake registration.
		return { kind: "invalid", error: "config.yaml is empty" };
	}

	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "invalid", error: "config.yaml must be a YAML mapping" };
	}

	const record = parsed as Record<string, unknown>;
	const rawAgentId = record.agent_id;
	let agentId: number | null;
	if (rawAgentId === undefined || rawAgentId === null) {
		// Field absent entirely — distinct from "present but -1". Treat as not
		// registered without inventing a concrete id.
		agentId = null;
	} else if (typeof rawAgentId === "number" && Number.isFinite(rawAgentId)) {
		agentId = rawAgentId;
	} else {
		return {
			kind: "invalid",
			error: `config.yaml agent_id must be a finite number (got ${typeof rawAgentId})`,
		};
	}

	const rawChain = record.chain;
	const chain = typeof rawChain === "string" && rawChain.length > 0 ? rawChain : null;

	return { kind: "parsed", agentId, chain };
}

async function readContacts(dataDir: string): Promise<Contact[]> {
	try {
		return await new FileTrustStore(dataDir).getContacts();
	} catch {
		return [];
	}
}

async function readJournal(dataDir: string): Promise<RequestJournalEntry[]> {
	try {
		return await new FileRequestJournal(dataDir).list();
	} catch {
		return [];
	}
}

async function readConversations(dataDir: string): Promise<ConversationLog[]> {
	try {
		return await new FileConversationLogger(dataDir).listConversations();
	} catch {
		return [];
	}
}

async function readHermesStatus(
	hermesHomeOverride: string | undefined,
	dataDir: string,
): Promise<HermesStatus | null> {
	const hermesHome = resolveHermesHome(hermesHomeOverride);
	let config: TapHermesPluginConfig;
	try {
		config = await loadTapHermesPluginConfig(hermesHome);
	} catch {
		return null;
	}

	let daemonState: TapHermesDaemonState | null = null;
	try {
		daemonState = await readHermesTapDaemonState(hermesHome);
	} catch {
		daemonState = null;
	}

	const daemonRunning = daemonState ? isProcessAlive(daemonState.pid) : false;
	const normalizedDataDir = resolvePath(dataDir);
	const managesThisDataDir = config.identities.some(
		(identity) => resolvePath(identity.dataDir) === normalizedDataDir,
	);
	const installed = config.identities.length > 0 || daemonState !== null;

	if (!installed) {
		return null;
	}

	return {
		installed,
		daemon_running: daemonRunning,
		daemon_pid: daemonState?.pid ?? null,
		gateway_pid: daemonState?.gatewayPid ?? null,
		manages_this_data_dir: managesThisDataDir,
		configured_identities: config.identities.map((identity) => identity.name),
	};
}

function detectMode(input: {
	configState: ConfigState;
	registered: boolean;
	transportOwner: (TransportOwnerInfo & { alive: boolean }) | null;
}): HostMode {
	if (input.configState.kind === "missing") return "not-initialized";
	if (input.configState.kind === "invalid") return "config-invalid";
	if (!input.registered) return "not-registered";

	const owner = input.transportOwner;
	if (!owner || !owner.alive) return "idle";

	if (owner.owner.startsWith("hermes:")) return "hermes-managed";
	if (owner.owner.startsWith("openclaw:")) return "openclaw-managed";
	if (owner.owner === "tap:listen") return "cli-listener";
	if (owner.owner.startsWith("tap:")) return "cli-transient";
	return "unknown-owner";
}

function summarizeContacts(contacts: Contact[]): StatusPayload["contacts"] {
	const active = contacts.filter((c) => c.status === "active").length;
	const connecting = contacts.filter((c) => c.status === "connecting");
	const oldestConnecting = connecting
		.slice()
		.sort((a, b) => a.establishedAt.localeCompare(b.establishedAt))[0];

	return {
		total: contacts.length,
		active,
		connecting: connecting.length,
		oldest_connecting: oldestConnecting
			? {
					peer: `${oldestConnecting.peerDisplayName} (#${oldestConnecting.peerAgentId})`,
					established_at: oldestConnecting.establishedAt,
					age_minutes: ageMinutes(oldestConnecting.establishedAt),
				}
			: null,
	};
}

function summarizeMessages(conversations: ConversationLog[]): StatusPayload["messages"] {
	// Conversation logs are the source of truth for "did any actual peer
	// communication happen?". `sendMessageInternal` writes to conversations
	// but does NOT add a message/send row to the request journal, so counting
	// from the journal silently drops every successful outbound send.
	// Conversations capture both message/send and action/* traffic, which is
	// exactly what "real peer messages" means for a debug-first command —
	// handshake traffic (connection/*) is not logged there.
	let inbound = 0;
	let outbound = 0;
	let latestIn: { entry: MessageSummary } | null = null;
	let latestOut: { entry: MessageSummary } | null = null;

	for (const log of conversations) {
		const peerLabel = `${log.peerDisplayName} (#${log.peerAgentId})`;
		for (const message of log.messages) {
			if (message.direction === "incoming") {
				inbound += 1;
				if (!latestIn || message.timestamp > latestIn.entry.at) {
					latestIn = {
						entry: { peer: peerLabel, peer_agent_id: log.peerAgentId, at: message.timestamp },
					};
				}
			} else if (message.direction === "outgoing") {
				outbound += 1;
				if (!latestOut || message.timestamp > latestOut.entry.at) {
					latestOut = {
						entry: { peer: peerLabel, peer_agent_id: log.peerAgentId, at: message.timestamp },
					};
				}
			}
		}
	}

	return {
		inbound_count: inbound,
		outbound_count: outbound,
		last_inbound: latestIn?.entry ?? null,
		last_outbound: latestOut?.entry ?? null,
	};
}

function summarizeJournal(entries: RequestJournalEntry[]): StatusPayload["journal"] {
	const nonCompleted = entries.filter((e) => e.status !== "completed");
	const inboundPending = nonCompleted.filter((e) => e.direction === "inbound").length;
	const outboundPending = nonCompleted.filter((e) => e.direction === "outbound").length;
	const queuedCommands = entries.filter(
		(e) => e.status === "queued" && e.method.startsWith("command/"),
	).length;

	const oldest = nonCompleted.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

	return {
		inbound_pending: inboundPending,
		outbound_pending: outboundPending,
		queued_commands: queuedCommands,
		oldest_pending: oldest
			? {
					request_id: oldest.requestId,
					method: oldest.method,
					direction: oldest.direction,
					age_minutes: ageMinutes(oldest.createdAt),
					...(oldest.metadata?.lastError?.message
						? { last_error: oldest.metadata.lastError.message }
						: {}),
				}
			: null,
	};
}

function buildWarnings(input: {
	configState: ConfigState;
	registered: boolean;
	transportOwner: (TransportOwnerInfo & { alive: boolean }) | null;
	contactsSummary: StatusPayload["contacts"];
	journalSummary: StatusPayload["journal"];
	hermes: HermesStatus | null;
}): string[] {
	const warnings: string[] = [];

	if (input.configState.kind === "missing") {
		warnings.push("No TAP config at this data dir. Run `tap init` to create one.");
		return warnings;
	}

	if (input.configState.kind === "invalid") {
		warnings.push(
			`config.yaml exists but cannot be parsed: ${input.configState.error}. Fix it by hand or re-run \`tap init\`.`,
		);
		return warnings;
	}

	if (!input.registered) {
		warnings.push(
			"Agent has no on-chain identity yet (agent_id missing or < 0). Run `tap register` to finish onboarding.",
		);
	}

	if (input.transportOwner && !input.transportOwner.alive) {
		warnings.push(
			`Stale transport lock: ${input.transportOwner.owner} (pid ${input.transportOwner.pid}) is not running. The next transport-active command will recover it automatically.`,
		);
	}

	if (
		input.contactsSummary.oldest_connecting &&
		input.contactsSummary.oldest_connecting.age_minutes >= STUCK_CONNECTING_THRESHOLD_MINUTES
	) {
		warnings.push(
			`Contact ${input.contactsSummary.oldest_connecting.peer} has been in 'connecting' state for ${input.contactsSummary.oldest_connecting.age_minutes} minutes. Try \`tap message sync\`.`,
		);
	}

	if (input.journalSummary.queued_commands > 0 && !input.transportOwner) {
		warnings.push(
			`${input.journalSummary.queued_commands} queued command(s) in journal but no transport owner is draining them. Start \`tap message listen\` or restart the host that owns this data dir.`,
		);
	}

	if (input.hermes?.daemon_running && !input.hermes.manages_this_data_dir) {
		warnings.push(
			"Hermes TAP daemon is running but this data-dir is not in its configured identities. If you expected Hermes to own this agent's transport, run `tap hermes configure --name <name>` from this data dir.",
		);
	}

	if (input.hermes?.manages_this_data_dir && !input.hermes.daemon_running) {
		warnings.push(
			"Hermes is configured to manage this data-dir but the TAP daemon is not running. Start or restart `hermes gateway`.",
		);
	}

	return warnings;
}

function ageMinutes(iso: string): number {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return 0;
	return Math.max(0, Math.round((Date.now() - t) / 60_000));
}
