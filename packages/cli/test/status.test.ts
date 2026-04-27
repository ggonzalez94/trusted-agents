import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Contact,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	TransportOwnerLock,
	contactsFilePath,
	legacyConversationsDir,
	requestJournalPath,
	transportOwnerLockPath,
} from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusCommand } from "../src/commands/status.js";
import { getTapHermesPaths, saveTapHermesPluginConfig } from "../src/hermes/config.js";
import { defaultConfigPath } from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { UNREGISTERED_AGENT_CONFIG_YAML, buildAgentConfigYaml } from "./helpers/config-fixtures.js";

const MINIMAL_CONFIG = buildAgentConfigYaml({ agentId: 42 });

async function makeAgentDir(root: string, config = MINIMAL_CONFIG): Promise<string> {
	const dataDir = join(root, "agent");
	await mkdir(dataDir, { recursive: true });
	await writeFile(defaultConfigPath(dataDir), config, "utf-8");
	return dataDir;
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		connectionId: "conn-1",
		peerAgentId: 100,
		peerChain: "eip155:8453",
		peerOwnerAddress: "0x0000000000000000000000000000000000000000",
		peerDisplayName: "Alice",
		peerAgentAddress: "0x0000000000000000000000000000000000000000",
		permissions: { transferGrants: [], schedulingGrants: [] },
		establishedAt: new Date().toISOString(),
		lastContactAt: new Date().toISOString(),
		status: "active",
		...overrides,
	};
}

interface StatusResponse {
	status: string;
	data?: {
		config: {
			exists: boolean;
			valid: boolean;
			agent_id: number | null;
			registered: boolean;
		};
		host: {
			mode: string;
			transport_owner: { owner: string; alive: boolean } | null;
			hermes: {
				daemon_running: boolean;
				manages_this_data_dir: boolean;
				configured_identities: string[];
			} | null;
		};
		contacts: {
			total: number;
			active: number;
			connecting: number;
			oldest_connecting: { peer: string; age_minutes: number } | null;
		};
		messages: {
			inbound_count: number;
			outbound_count: number;
			last_inbound: { peer: string; at: string } | null;
			last_outbound: { peer: string; at: string } | null;
		};
		journal: {
			inbound_pending: number;
			outbound_pending: number;
			queued_commands: number;
			oldest_pending: { method: string; direction: string } | null;
		};
		warnings: string[];
	};
	error?: { code: string; message: string };
}

function readResponse(stdout: string[]): StatusResponse {
	return JSON.parse(stdout.join("")) as StatusResponse;
}

describe("tap status", () => {
	let tempRoot: string;
	let hermesHome: string;
	let originalHermesHome: string | undefined;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-status-"));
		hermesHome = join(tempRoot, "hermes-home");
		await mkdir(hermesHome, { recursive: true });
		originalHermesHome = process.env.HERMES_HOME;
		process.env.HERMES_HOME = hermesHome;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		if (originalHermesHome === undefined) {
			// `process.env.FOO = undefined` coerces to the string "undefined"
			// in Node; we must `delete` the key to actually unset it and not
			// leak a bogus HERMES_HOME into later suites.
			// biome-ignore lint/performance/noDelete: process.env requires delete to unset
			delete process.env.HERMES_HOME;
		} else {
			process.env.HERMES_HOME = originalHermesHome;
		}
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("reports not-initialized when no config exists", async () => {
		const dataDir = join(tempRoot, "empty-agent");
		await mkdir(dataDir, { recursive: true });

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.status).toBe("ok");
		expect(output.data?.host.mode).toBe("not-initialized");
		expect(output.data?.config.exists).toBe(false);
		expect(output.data?.warnings).toContain(
			"No TAP config at this data dir. Run `tap init` to create one.",
		);
		expect(stderrWrites).toEqual([]);
	});

	it("reports not-registered when agent_id < 0", async () => {
		const dataDir = await makeAgentDir(tempRoot, UNREGISTERED_AGENT_CONFIG_YAML);

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("not-registered");
		expect(output.data?.config.registered).toBe(false);
		expect(output.data?.warnings.some((w) => w.includes("tap register"))).toBe(true);
	});

	it("reports idle when config is valid but nothing owns the transport", async () => {
		const dataDir = await makeAgentDir(tempRoot);

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("idle");
		expect(output.data?.host.transport_owner).toBeNull();
		expect(output.data?.config.registered).toBe(true);
		expect(output.data?.config.agent_id).toBe(42);
	});

	it("detects cli-listener when tap:listen owns the transport", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const lock = new TransportOwnerLock(dataDir, "tap:listen");
		await lock.acquire();
		try {
			await statusCommand({}, { json: true, dataDir });
		} finally {
			await lock.release();
		}

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("cli-listener");
		expect(output.data?.host.transport_owner?.owner).toBe("tap:listen");
		expect(output.data?.host.transport_owner?.alive).toBe(true);
	});

	it("detects hermes-managed mode and matches data dir", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const lock = new TransportOwnerLock(dataDir, "hermes:default");
		await lock.acquire();
		await saveTapHermesPluginConfig(hermesHome, {
			identities: [{ name: "default", dataDir, reconcileIntervalMinutes: 10 }],
		});
		try {
			await statusCommand({ hermesHome }, { json: true, dataDir });
		} finally {
			await lock.release();
		}

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("hermes-managed");
		expect(output.data?.host.hermes?.manages_this_data_dir).toBe(true);
		expect(output.data?.host.hermes?.configured_identities).toEqual(["default"]);
	});

	it("warns when Hermes is configured for a different data-dir but daemon is running", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await saveTapHermesPluginConfig(hermesHome, {
			identities: [
				{ name: "other", dataDir: join(tempRoot, "other-agent"), reconcileIntervalMinutes: 10 },
			],
		});
		// Simulate a live hermes daemon state file pointing at our PID (self,
		// so isProcessAlive returns true).
		const hermesPaths = getTapHermesPaths(hermesHome);
		await mkdir(hermesPaths.stateDir, { recursive: true });
		await writeFile(
			hermesPaths.daemonStatePath,
			JSON.stringify({
				pid: process.pid,
				gatewayPid: process.pid,
				socketPath: hermesPaths.socketPath,
				startedAt: new Date().toISOString(),
				identities: ["other"],
			}),
		);

		await statusCommand({ hermesHome }, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.hermes?.daemon_running).toBe(true);
		expect(output.data?.host.hermes?.manages_this_data_dir).toBe(false);
		expect(output.data?.warnings.some((w) => w.includes("not in its configured identities"))).toBe(
			true,
		);
	});

	it("separates handshake state from message/send state", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const store = new FileTrustStore(dataDir);
		await store.addContact(makeContact({ peerAgentId: 100, peerDisplayName: "Alice" }));
		await store.addContact(
			makeContact({
				connectionId: "conn-2",
				peerAgentId: 200,
				peerDisplayName: "Bob",
				status: "connecting",
				establishedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
			}),
		);

		const journal = new FileRequestJournal(dataDir);
		await journal.putOutbound({
			requestId: "conn-req-1",
			requestKey: "outbound:conn-req-1",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: 200,
			status: "completed",
		});

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		// Two contacts: one active, one stuck connecting — but zero actual messages.
		expect(output.data?.contacts.total).toBe(2);
		expect(output.data?.contacts.active).toBe(1);
		expect(output.data?.contacts.connecting).toBe(1);
		expect(output.data?.contacts.oldest_connecting?.peer).toContain("Bob");
		expect(output.data?.messages.inbound_count).toBe(0);
		expect(output.data?.messages.outbound_count).toBe(0);
		expect(output.data?.messages.last_inbound).toBeNull();
		expect(output.data?.warnings.some((w) => w.includes("Bob") && w.includes("connecting"))).toBe(
			true,
		);
	});

	it("counts inbound and outbound messages from the conversation log", async () => {
		// Conversation logs are the canonical source because sendMessageInternal
		// writes there but not to the request journal. Counting from the journal
		// would silently miss every successful outbound `tap message send`.
		const dataDir = await makeAgentDir(tempRoot);
		const logger = new FileConversationLogger(dataDir);
		const conversationId = "conv-alice";
		const context = {
			connectionId: "conn-1",
			peerAgentId: 100,
			peerDisplayName: "Alice",
		};
		await logger.logMessage(
			conversationId,
			{
				messageId: "in-1",
				timestamp: "2026-04-14T10:00:00.000Z",
				direction: "incoming",
				scope: "general-chat",
				content: "hi",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			context,
		);
		await logger.logMessage(
			conversationId,
			{
				messageId: "in-2",
				timestamp: "2026-04-14T10:05:00.000Z",
				direction: "incoming",
				scope: "general-chat",
				content: "still here",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			context,
		);
		await logger.logMessage(
			conversationId,
			{
				messageId: "out-1",
				timestamp: "2026-04-14T10:06:00.000Z",
				direction: "outgoing",
				scope: "general-chat",
				content: "hello",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			context,
		);

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.messages.inbound_count).toBe(2);
		expect(output.data?.messages.outbound_count).toBe(1);
		expect(output.data?.messages.last_inbound?.peer).toContain("Alice");
		expect(output.data?.messages.last_inbound?.at).toBe("2026-04-14T10:05:00.000Z");
		expect(output.data?.messages.last_outbound?.peer).toContain("Alice");
		expect(output.data?.messages.last_outbound?.at).toBe("2026-04-14T10:06:00.000Z");
	});

	it("reports config-invalid when config.yaml is empty", async () => {
		const dataDir = join(tempRoot, "broken-agent");
		await mkdir(dataDir, { recursive: true });
		await writeFile(defaultConfigPath(dataDir), "", "utf-8");

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("config-invalid");
		expect(output.data?.config.exists).toBe(true);
		expect(output.data?.config.valid).toBe(false);
		expect(output.data?.config.registered).toBe(false);
		expect(output.data?.warnings.some((w) => w.includes("cannot be parsed"))).toBe(true);
		// Must not fall into the `tap register` remediation path.
		expect(output.data?.warnings.some((w) => w.includes("tap register"))).toBe(false);
	});

	it("reports config-invalid when config.yaml has garbage yaml", async () => {
		const dataDir = join(tempRoot, "broken-yaml-agent");
		await mkdir(dataDir, { recursive: true });
		await writeFile(defaultConfigPath(dataDir), "not: [valid: yaml", "utf-8");

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("config-invalid");
		expect(output.data?.config.valid).toBe(false);
		expect(output.data?.warnings.some((w) => w.includes("cannot be parsed"))).toBe(true);
	});

	it("reports not-registered when agent_id key is missing from config.yaml", async () => {
		// This is the real trap the loader creates: yaml without agent_id was
		// previously defaulted to 0 and reported as registered=true. Guard
		// against regression.
		const dataDir = await makeAgentDir(
			tempRoot,
			["chain: eip155:8453", "ows:", "  wallet: demo-wallet", "  api_key: demo-key"].join("\n"),
		);

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.mode).toBe("not-registered");
		expect(output.data?.config.valid).toBe(true);
		expect(output.data?.config.agent_id).toBeNull();
		expect(output.data?.config.registered).toBe(false);
	});

	it("rejects --config pointing outside the selected data dir", async () => {
		const dataDirA = await makeAgentDir(tempRoot);
		// Move foreign config into a directory separate from dataDirA so the
		// paths genuinely mismatch. `validateConfigPathInDataDir` only fires
		// when both --data-dir and --config are set and point at different
		// parents.
		const foreignParent = join(tempRoot, "agent-b");
		await mkdir(foreignParent, { recursive: true });
		const foreignConfig = defaultConfigPath(foreignParent);
		await writeFile(
			foreignConfig,
			["agent_id: 7", "chain: eip155:8453", "ows:", "  wallet: other", "  api_key: other"].join(
				"\n",
			),
			"utf-8",
		);

		await statusCommand({}, { json: true, dataDir: dataDirA, config: foreignConfig });

		const output = readResponse(stdoutWrites);
		expect(output.status).toBe("error");
		expect(output.error?.message).toContain("Config path must match the TAP data dir");
	});

	it("flags queued commands with no transport owner", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const journal = new FileRequestJournal(dataDir);
		await journal.putOutbound({
			requestId: "cmd-1",
			requestKey: "outbound:command:cmd-1",
			direction: "outbound",
			kind: "request",
			method: "command/connect",
			peerAgentId: 0,
			status: "queued",
			metadata: { commandType: "connect", commandPayload: { inviteUrl: "tap://demo" } },
		});

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.journal.queued_commands).toBe(1);
		expect(output.data?.warnings.some((w) => w.includes("queued command"))).toBe(true);
	});

	it("flags queued commands even when a stale (dead-pid) lock is present", async () => {
		// Prior bug: the queued-commands warning was gated on
		// `!input.transportOwner`, which is false when a stale lock file exists.
		// In that state the operator only saw "stale lock" but not "nothing is
		// draining your queue". Both matter because queued work is equally
		// undrained in both cases.
		const dataDir = await makeAgentDir(tempRoot);

		// Write a lock file pointing at a pid that can't be alive.
		const lockPath = transportOwnerLockPath(dataDir);
		await writeFile(
			lockPath,
			JSON.stringify({
				pid: 999_999_999,
				owner: "tap:listen",
				acquiredAt: new Date().toISOString(),
			}),
			"utf-8",
		);

		const journal = new FileRequestJournal(dataDir);
		await journal.putOutbound({
			requestId: "cmd-stale",
			requestKey: "outbound:command:cmd-stale",
			direction: "outbound",
			kind: "request",
			method: "command/connect",
			peerAgentId: 0,
			status: "queued",
			metadata: { commandType: "connect", commandPayload: { inviteUrl: "tap://demo" } },
		});

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.transport_owner?.alive).toBe(false);
		expect(output.data?.warnings.some((w) => w.includes("Stale transport lock"))).toBe(true);
		expect(
			output.data?.warnings.some((w) => w.includes("queued command") && w.includes("draining")),
		).toBe(true);
	});

	it("surfaces corrupt request-journal.json as a warning instead of silent zero", async () => {
		// A diagnosis command must never silently turn file corruption into
		// "everything is fine". Prior bug: a catch-all in readJournal returned
		// [] for JSON parse failures.
		const dataDir = await makeAgentDir(tempRoot);
		await writeFile(requestJournalPath(dataDir), "{ not json", "utf-8");

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.journal.inbound_pending).toBe(0);
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Failed to read request-journal.json") && w.includes("incomplete"),
			),
		).toBe(true);
	});

	it("surfaces corrupt contacts.json as a warning", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		await writeFile(contactsFilePath(dataDir), "[not an object", "utf-8");

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Failed to read contacts.json") && w.includes("incomplete"),
			),
		).toBe(true);
	});

	it("surfaces a corrupt .transport.lock instead of aborting the command", async () => {
		// Prior bug: an unguarded TransportOwnerLock.inspect() call meant a
		// malformed lock file aborted the whole status command — which is
		// exactly the crash-recovery scenario tap status exists to diagnose.
		const dataDir = await makeAgentDir(tempRoot);
		await writeFile(transportOwnerLockPath(dataDir), "{ not json", "utf-8");

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.status).toBe("ok");
		expect(output.data?.host.transport_owner).toBeNull();
		// Mode must be `transport-unknown`, not `idle` — ownership is explicitly
		// unknown when the lock is unreadable, and JSON consumers that key off
		// `mode` alone must not be misled into thinking the data dir is idle.
		expect(output.data?.host.mode).toBe("transport-unknown");
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Failed to read .transport.lock") && w.includes("unknown"),
			),
		).toBe(true);
	});

	it("rejects schema-invalid conversation files instead of crashing summarizeMessages", async () => {
		// Prior bug: readConversations accepted any parseable JSON as a
		// ConversationLog, so `{}`, `{"messages": null}`, or
		// `{"messages": [null]}` made it to summarizeMessages which then threw
		// on iteration.
		const dataDir = await makeAgentDir(tempRoot);
		const conversationsDir = legacyConversationsDir(dataDir);
		await mkdir(conversationsDir, { recursive: true });
		// Schema-invalid: missing messages array
		await writeFile(join(conversationsDir, "conv-empty.json"), "{}", "utf-8");
		// Schema-invalid: messages is not an array
		await writeFile(
			join(conversationsDir, "conv-null-messages.json"),
			JSON.stringify({ messages: null, peerAgentId: 1, peerDisplayName: "X" }),
			"utf-8",
		);
		// Schema-invalid: messages contains non-object entries
		await writeFile(
			join(conversationsDir, "conv-null-element.json"),
			JSON.stringify({ messages: [null], peerAgentId: 1, peerDisplayName: "X" }),
			"utf-8",
		);
		// Schema-invalid: message entry is missing direction
		await writeFile(
			join(conversationsDir, "conv-bad-direction.json"),
			JSON.stringify({
				messages: [{ timestamp: "2026-01-01T00:00:00Z" }],
				peerAgentId: 1,
				peerDisplayName: "X",
			}),
			"utf-8",
		);

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.status).toBe("ok");
		expect(output.data?.messages.inbound_count).toBe(0);
		expect(
			output.data?.warnings.some(
				(w) =>
					w.includes("conversation file(s) unreadable") &&
					(w.includes("conv-empty") ||
						w.includes("conv-null-messages") ||
						w.includes("conv-null-element") ||
						w.includes("conv-bad-direction")),
			),
		).toBe(true);
	});

	it("suppresses the queued-commands warning when the lock is unreadable", async () => {
		// Prior bug: when .transport.lock was corrupt, transportOwner was null
		// and transportIdle therefore true — so the queued-commands warning
		// fired even though ownership was actually unknown. A live host might
		// still be draining the queue.
		const dataDir = await makeAgentDir(tempRoot);
		await writeFile(transportOwnerLockPath(dataDir), "{ not json", "utf-8");
		const journal = new FileRequestJournal(dataDir);
		await journal.putOutbound({
			requestId: "cmd-unknown",
			requestKey: "outbound:command:cmd-unknown",
			direction: "outbound",
			kind: "request",
			method: "command/connect",
			peerAgentId: 0,
			status: "queued",
			metadata: { commandType: "connect", commandPayload: { inviteUrl: "tap://demo" } },
		});

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		// The lock-read error warning MUST fire
		expect(output.data?.warnings.some((w) => w.includes("Failed to read .transport.lock"))).toBe(
			true,
		);
		// The queued-commands-idle warning MUST NOT fire — ownership is unknown
		expect(
			output.data?.warnings.some((w) => w.includes("queued command") && w.includes("draining")),
		).toBe(false);
	});

	it("surfaces corrupt individual conversation files as a warning", async () => {
		// Prior bug: FileConversationLogger.listConversations silently skips
		// files that fail to parse. That hid real corruption behind an
		// undercount with no warning.
		const dataDir = await makeAgentDir(tempRoot);

		// Seed one valid conversation via the logger.
		const logger = new FileConversationLogger(dataDir);
		await logger.logMessage(
			"conv-alice",
			{
				messageId: "in-1",
				timestamp: "2026-04-14T10:00:00.000Z",
				direction: "incoming",
				scope: "general-chat",
				content: "hi",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{ connectionId: "conn-1", peerAgentId: 100, peerDisplayName: "Alice" },
		);
		// Seed a corrupt file next to it.
		await writeFile(
			join(legacyConversationsDir(dataDir), "conv-broken.json"),
			"{ not json",
			"utf-8",
		);

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		// Good file still counted
		expect(output.data?.messages.inbound_count).toBe(1);
		// Bad file reported as warning
		expect(
			output.data?.warnings.some(
				(w) => w.includes("conversation file(s) unreadable") && w.includes("conv-broken"),
			),
		).toBe(true);
	});

	it("suppresses identity-mismatch warning when hermes config is unreadable", async () => {
		// Prior bug: when config.json is malformed, readHermesStatus forces
		// manages_this_data_dir=false (can't read identities), then downstream
		// the "daemon is running but this data-dir is not in configured
		// identities" warning fires — even though the actual problem is the
		// unreadable config, not a missing identity.
		const dataDir = await makeAgentDir(tempRoot);
		const hermesPaths = getTapHermesPaths(hermesHome);
		await mkdir(hermesPaths.pluginDir, { recursive: true });
		await writeFile(hermesPaths.configPath, "{ not: json", "utf-8");

		// And a live daemon state pointing at our pid so daemon_running is true.
		await mkdir(hermesPaths.stateDir, { recursive: true });
		await writeFile(
			hermesPaths.daemonStatePath,
			JSON.stringify({
				pid: process.pid,
				gatewayPid: process.pid,
				socketPath: hermesPaths.socketPath,
				startedAt: new Date().toISOString(),
				identities: [],
			}),
		);

		await statusCommand({ hermesHome }, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		// Config-error warning MUST fire (the real problem)
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Hermes TAP plugin config") && w.includes("cannot be parsed"),
			),
		).toBe(true);
		// Contradictory "not in configured identities" warning MUST NOT fire
		expect(output.data?.warnings.some((w) => w.includes("not in its configured identities"))).toBe(
			false,
		);
	});

	it("suppresses daemon-not-running warning when daemon.json is unreadable", async () => {
		// Prior bug: when daemon.json is malformed, daemon_running defaults to
		// false; the "TAP daemon is not running" warning then fires even though
		// the daemon may actually be running — contradicting the
		// daemon-state-error warning that correctly says "running state is
		// unknown".
		const dataDir = await makeAgentDir(tempRoot);
		await saveTapHermesPluginConfig(hermesHome, {
			identities: [{ name: "default", dataDir, reconcileIntervalMinutes: 10 }],
		});
		const hermesPaths = getTapHermesPaths(hermesHome);
		await mkdir(hermesPaths.stateDir, { recursive: true });
		await writeFile(hermesPaths.daemonStatePath, "{ not json", "utf-8");

		await statusCommand({ hermesHome }, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		// Daemon-state-error warning MUST fire
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Hermes TAP daemon state file") && w.includes("cannot be parsed"),
			),
		).toBe(true);
		// Contradictory "daemon is not running" warning MUST NOT fire
		expect(
			output.data?.warnings.some(
				(w) => w.includes("TAP daemon is not running") || w.includes("Start or restart"),
			),
		).toBe(false);
	});

	it("surfaces a corrupt Hermes daemon.json as a warning", async () => {
		// Prior bug: readHermesStatus's unconditional catch around
		// readHermesTapDaemonState coerced parse errors to null, so a broken
		// daemon.json looked exactly like "daemon is not running".
		const dataDir = await makeAgentDir(tempRoot);
		// Install a valid hermes config so this data-dir is recognized as
		// Hermes-managed, then write garbage in daemon.json.
		await saveTapHermesPluginConfig(hermesHome, {
			identities: [{ name: "default", dataDir, reconcileIntervalMinutes: 10 }],
		});
		const hermesPaths = getTapHermesPaths(hermesHome);
		await mkdir(hermesPaths.stateDir, { recursive: true });
		await writeFile(hermesPaths.daemonStatePath, "{ not json", "utf-8");

		await statusCommand({ hermesHome }, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Hermes TAP daemon state file") && w.includes("cannot be parsed"),
			),
		).toBe(true);
	});

	it("surfaces a broken Hermes plugin config instead of reporting not-installed", async () => {
		// Prior bug: readHermesStatus caught all errors from
		// loadTapHermesPluginConfig and returned null, making "installed but
		// config.json is garbage" indistinguishable from "Hermes is not
		// installed". The whole point of the debug command is to expose the
		// root cause.
		const dataDir = await makeAgentDir(tempRoot);
		const hermesPaths = getTapHermesPaths(hermesHome);
		await mkdir(hermesPaths.pluginDir, { recursive: true });
		await writeFile(hermesPaths.configPath, "{ not: json", "utf-8");

		await statusCommand({ hermesHome }, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(output.data?.host.hermes).not.toBeNull();
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Hermes TAP plugin config") && w.includes("cannot be parsed"),
			),
		).toBe(true);
	});
});
