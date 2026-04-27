import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
	type Contact,
	type ConversationLog,
	FileRequestJournal,
	FileTrustStore,
	type RequestJournalEntry,
	type TransportOwnerInfo,
	TransportOwnerLock,
	fsErrorCode,
	isProcessAlive,
	isRecord,
	resolveDataDir as resolveDataDirPath,
} from "trusted-agents-core";
import {
	type TapHermesDaemonState,
	type TapHermesPluginConfig,
	loadTapHermesDaemonState,
	loadTapHermesPluginConfig,
	resolveHermesHome,
} from "../hermes/config.js";
import { readJsonFile, readYamlFileSync } from "../lib/atomic-write.js";
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
	| "transport-unknown"
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
	/** Populated when the plugin config exists but cannot be parsed. */
	config_error?: string;
	/** Populated when daemon.json exists but cannot be parsed. */
	daemon_state_error?: string;
}

interface MessageSummary {
	peer: string;
	peer_agent_id: number;
	at: string;
}

interface ReadResult<T> {
	value: T;
	error?: string;
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

		// `TransportOwnerLock.inspect()` throws on JSON parse / non-ENOENT I/O
		// failures (see transport-owner-lock.ts `readOwner`). A corrupt
		// `.transport.lock` file must not abort the whole status command —
		// crash-recovery is its main use case and stale/damaged locks are
		// exactly what it's there to surface.
		let transportOwner: (TransportOwnerInfo & { alive: boolean }) | null = null;
		let transportOwnerError: string | undefined;
		try {
			const ownerInspector = new TransportOwnerLock(dataDir, "tap:status");
			const rawOwner = await ownerInspector.inspect();
			if (rawOwner) {
				transportOwner = { ...rawOwner, alive: isProcessAlive(rawOwner.pid) };
			}
		} catch (err) {
			transportOwnerError = formatReadError(err);
		}

		const contactsRead = await readContacts(dataDir);
		const journalRead = await readJournal(dataDir);
		const conversationsRead = await readConversations(dataDir);
		const hermes = await readHermesStatus(flags.hermesHome, dataDir);

		const mode = detectMode({
			configState,
			registered,
			transportOwner,
			transportOwnerError,
		});

		const contactsSummary = summarizeContacts(contactsRead.value);
		const messages = summarizeMessages(conversationsRead.value);
		const journalSummary = summarizeJournal(journalRead.value);

		const warnings = buildWarnings({
			configState,
			registered,
			transportOwner,
			contactsSummary,
			journalSummary,
			hermes,
			readErrors: {
				contacts: contactsRead.error,
				journal: journalRead.error,
				conversations: conversationsRead.error,
				transportOwner: transportOwnerError,
			},
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

	let parsed: unknown;
	try {
		parsed = readYamlFileSync(configPath);
	} catch (err) {
		return { kind: "invalid", error: err instanceof Error ? err.message : String(err) };
	}

	if (parsed === null || parsed === undefined) {
		// Empty file. Treat as present-but-unusable so we don't fake registration.
		return { kind: "invalid", error: "config.yaml is empty" };
	}

	if (!isRecord(parsed)) {
		return { kind: "invalid", error: "config.yaml must be a YAML mapping" };
	}

	const rawAgentId = parsed.agent_id;
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

	const rawChain = parsed.chain;
	const chain = typeof rawChain === "string" && rawChain.length > 0 ? rawChain : null;

	return { kind: "parsed", agentId, chain };
}

// ── Readers ──
//
// Each reader returns `{ value, error? }` so callers can distinguish "source is
// empty" from "source is corrupt/unreadable". Collapsing both into `[]` turns
// genuine file corruption into a fake "healthy" state — which is exactly when
// the operator runs `tap status` for diagnosis. The underlying File* stores
// already treat missing files as empty via ENOENT, so any error surfaced here
// is a real JSON-parse or I/O failure worth warning about.

async function readContacts(dataDir: string): Promise<ReadResult<Contact[]>> {
	try {
		return { value: await new FileTrustStore(dataDir).getContacts() };
	} catch (err) {
		return { value: [], error: formatReadError(err) };
	}
}

async function readJournal(dataDir: string): Promise<ReadResult<RequestJournalEntry[]>> {
	try {
		return { value: await new FileRequestJournal(dataDir).list() };
	} catch (err) {
		return { value: [], error: formatReadError(err) };
	}
}

async function readConversations(dataDir: string): Promise<ReadResult<ConversationLog[]>> {
	// `FileConversationLogger.listConversations()` silently swallows per-file
	// JSON parse errors and skips them (see logger.ts `// Skip corrupted files`
	// branch). For a diagnostic command that's a footgun — one corrupt file
	// silently undercounts messages without any warning. So we do our own scan
	// here, track the per-file failures, and surface them as a readable error
	// if any file couldn't be parsed.
	const conversationsDir = join(resolveDataDirPath(dataDir), "conversations");
	let entries: string[];
	try {
		entries = await readdir(conversationsDir);
	} catch (err) {
		if (fsErrorCode(err) === "ENOENT") {
			return { value: [] };
		}
		return { value: [], error: formatReadError(err) };
	}

	const value: ConversationLog[] = [];
	const failed: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const filePath = join(conversationsDir, entry);
		try {
			value.push(
				await readJsonFile(filePath, (parsed) => {
					if (!isConversationLog(parsed)) {
						throw new Error("Invalid conversation log");
					}
					return parsed;
				}),
			);
		} catch {
			failed.push(entry);
		}
	}

	if (failed.length === 0) {
		return { value };
	}

	const sample = failed.slice(0, 3).join(", ");
	const suffix = failed.length > 3 ? `, +${failed.length - 3} more` : "";
	return {
		value,
		error: `${failed.length} conversation file(s) unreadable: ${sample}${suffix}`,
	};
}

function formatReadError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConversationLog(value: unknown): value is ConversationLog {
	// Shape check must be strict enough that every field summarizeMessages
	// dereferences (`messages[i].direction`, `messages[i].timestamp`) is safe.
	// A file like `{}`, `{"messages": null}`, or even
	// `{"messages": [null]}` must be counted as "unreadable" rather than
	// crashing the whole command during iteration.
	if (!isRecord(value)) return false;
	if (!Array.isArray(value.messages)) return false;
	if (typeof value.peerAgentId !== "number") return false;
	if (typeof value.peerDisplayName !== "string") return false;
	for (const message of value.messages) {
		if (!isRecord(message)) return false;
		const entry = message;
		if (entry.direction !== "incoming" && entry.direction !== "outgoing") return false;
		if (typeof entry.timestamp !== "string") return false;
	}
	return true;
}

async function readHermesStatus(
	hermesHomeOverride: string | undefined,
	dataDir: string,
): Promise<HermesStatus | null> {
	const hermesHome = resolveHermesHome(hermesHomeOverride);

	// `loadTapHermesDaemonState` treats ENOENT as "no daemon running" but throws
	// on JSON-parse / non-ENOENT I/O failures. We must distinguish those so a
	// malformed daemon.json shows up as a warning instead of looking exactly
	// like "Hermes is not running".
	let daemonState: TapHermesDaemonState | null = null;
	let daemonStateError: string | undefined;
	try {
		daemonState = await loadTapHermesDaemonState(hermesHome);
	} catch (err) {
		daemonStateError = formatReadError(err);
	}

	let config: TapHermesPluginConfig | null = null;
	let configError: string | undefined;
	try {
		config = await loadTapHermesPluginConfig(hermesHome);
	} catch (err) {
		// The config file exists but is unreadable or malformed. Report this
		// as "installed but broken" so the operator sees the root cause instead
		// of a false "Hermes isn't installed" silence.
		configError = formatReadError(err);
	}

	const daemonRunning = daemonState ? isProcessAlive(daemonState.pid) : false;

	if (!config) {
		// `config` is only `null` when `loadTapHermesPluginConfig` threw, which
		// means `configError` is set. The loader returns `{ identities: [] }`
		// on ENOENT, never `null`, so there is no "no config at all" branch to
		// worry about here. Treat this as installed-but-broken so the config
		// error / daemon warnings still fire.
		return {
			installed: true,
			daemon_running: daemonRunning,
			daemon_pid: daemonState?.pid ?? null,
			gateway_pid: daemonState?.gatewayPid ?? null,
			manages_this_data_dir: false,
			configured_identities: [],
			...(configError ? { config_error: configError } : {}),
			...(daemonStateError ? { daemon_state_error: daemonStateError } : {}),
		};
	}

	const normalizedDataDir = resolvePath(dataDir);
	const managesThisDataDir = config.identities.some(
		(identity) => resolvePath(identity.dataDir) === normalizedDataDir,
	);
	const installed =
		config.identities.length > 0 || daemonState !== null || daemonStateError !== undefined;

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
		...(daemonStateError ? { daemon_state_error: daemonStateError } : {}),
	};
}

function detectMode(input: {
	configState: ConfigState;
	registered: boolean;
	transportOwner: (TransportOwnerInfo & { alive: boolean }) | null;
	transportOwnerError: string | undefined;
}): HostMode {
	if (input.configState.kind === "missing") return "not-initialized";
	if (input.configState.kind === "invalid") return "config-invalid";
	if (!input.registered) return "not-registered";

	// A read failure on `.transport.lock` means ownership is unknown, NOT
	// idle. Automation / JSON consumers that key off `mode` must not be told
	// "idle" when we explicitly couldn't read the lock file.
	if (input.transportOwnerError !== undefined) return "transport-unknown";

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
	readErrors: {
		contacts?: string;
		journal?: string;
		conversations?: string;
		transportOwner?: string;
	};
}): string[] {
	const warnings: string[] = [];

	// Surface read failures first — if a store is unreadable, every other
	// derived metric is silently zero and would mislead the operator.
	if (input.readErrors.transportOwner) {
		warnings.push(
			`Failed to read .transport.lock: ${input.readErrors.transportOwner}. Transport owner state is unknown.`,
		);
	}
	if (input.readErrors.contacts) {
		warnings.push(
			`Failed to read contacts.json: ${input.readErrors.contacts}. Contact counts are incomplete.`,
		);
	}
	if (input.readErrors.journal) {
		warnings.push(
			`Failed to read request-journal.json: ${input.readErrors.journal}. Journal counts are incomplete.`,
		);
	}
	if (input.readErrors.conversations) {
		warnings.push(
			`Failed to read conversations/: ${input.readErrors.conversations}. Message counts are incomplete.`,
		);
	}

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

	// Queued commands are equally undrained whether no lock exists OR the lock
	// belongs to a dead process. A truthy-but-`alive: false` owner must NOT
	// swallow this warning — the operator needs to see both the stale-lock
	// note and the "nothing is draining your queue" note.
	//
	// BUT: when the lock file itself is unreadable, ownership is *unknown*
	// rather than idle. A live host may well be draining the queue through a
	// process we just can't inspect. In that case the broken-lock warning is
	// already telling the operator what's wrong; we must not additionally
	// claim "nothing is draining your queue" because that can be a false
	// diagnosis.
	const transportOwnershipKnown = input.readErrors.transportOwner === undefined;
	const transportIdle = !input.transportOwner || !input.transportOwner.alive;
	if (input.journalSummary.queued_commands > 0 && transportIdle && transportOwnershipKnown) {
		warnings.push(
			`${input.journalSummary.queued_commands} queued command(s) in journal but no live transport owner is draining them. Start \`tap message listen\` or restart the host that owns this data dir.`,
		);
	}

	if (input.hermes?.config_error) {
		warnings.push(
			`Hermes TAP plugin config exists but cannot be parsed: ${input.hermes.config_error}. Fix it or re-run \`tap hermes configure\`.`,
		);
	}

	if (input.hermes?.daemon_state_error) {
		warnings.push(
			`Hermes TAP daemon state file exists but cannot be parsed: ${input.hermes.daemon_state_error}. The daemon running state is unknown until this is resolved.`,
		);
	}

	// The identity-mismatch and daemon-not-running warnings rely on `config`
	// and `daemon_state` being readable. When either is broken, we already
	// emit a dedicated warning pointing at the real problem — adding a
	// contradictory downstream diagnosis ("daemon is not running" when we
	// can't actually tell, or "not in configured identities" when we just
	// couldn't parse the identities list) just confuses the operator. Gate
	// on the same "is ownership actually known?" pattern the transport-lock
	// queued-commands warning uses.
	const hermesConfigReadable = input.hermes?.config_error === undefined;
	const hermesDaemonStateReadable = input.hermes?.daemon_state_error === undefined;

	if (input.hermes?.daemon_running && !input.hermes.manages_this_data_dir && hermesConfigReadable) {
		warnings.push(
			"Hermes TAP daemon is running but this data-dir is not in its configured identities. If you expected Hermes to own this agent's transport, run `tap hermes configure --name <name>` from this data dir.",
		);
	}

	if (
		input.hermes?.manages_this_data_dir &&
		!input.hermes.daemon_running &&
		hermesDaemonStateReadable
	) {
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
