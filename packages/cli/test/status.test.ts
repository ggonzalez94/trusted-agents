import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Contact,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	TransportOwnerLock,
} from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusCommand } from "../src/commands/status.js";
import { saveTapHermesPluginConfig } from "../src/hermes/config.js";
import { useCapturedOutput } from "./helpers/capture-output.js";

const MINIMAL_CONFIG = [
	"agent_id: 42",
	"chain: eip155:8453",
	"ows:",
	"  wallet: demo-wallet",
	"  api_key: demo-key",
].join("\n");

async function makeAgentDir(root: string, config = MINIMAL_CONFIG): Promise<string> {
	const dataDir = join(root, "agent");
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "config.yaml"), config, "utf-8");
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
			process.env.HERMES_HOME = undefined;
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
		const dataDir = await makeAgentDir(
			tempRoot,
			[
				"agent_id: -1",
				"chain: eip155:8453",
				"ows:",
				"  wallet: demo-wallet",
				"  api_key: demo-key",
			].join("\n"),
		);

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
		const daemonStatePath = join(
			hermesHome,
			"plugins",
			"trusted-agents-tap",
			"state",
			"daemon.json",
		);
		await mkdir(join(hermesHome, "plugins", "trusted-agents-tap", "state"), { recursive: true });
		await writeFile(
			daemonStatePath,
			JSON.stringify({
				pid: process.pid,
				gatewayPid: process.pid,
				socketPath: join(hermesHome, "tap-hermes.sock"),
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
		await writeFile(join(dataDir, "config.yaml"), "", "utf-8");

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
		await writeFile(join(dataDir, "config.yaml"), "not: [valid: yaml", "utf-8");

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
		const foreignConfig = join(foreignParent, "config.yaml");
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
		const lockPath = join(dataDir, ".transport.lock");
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
		await writeFile(join(dataDir, "request-journal.json"), "{ not json", "utf-8");

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
		await writeFile(join(dataDir, "contacts.json"), "[not an object", "utf-8");

		await statusCommand({}, { json: true, dataDir });

		const output = readResponse(stdoutWrites);
		expect(
			output.data?.warnings.some(
				(w) => w.includes("Failed to read contacts.json") && w.includes("incomplete"),
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
		const hermesPluginDir = join(hermesHome, "plugins", "trusted-agents-tap");
		await mkdir(hermesPluginDir, { recursive: true });
		await writeFile(join(hermesPluginDir, "config.json"), "{ not: json", "utf-8");

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
