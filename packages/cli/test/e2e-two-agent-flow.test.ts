import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	generateInvite,
} from "trusted-agents-core";
import type { TransportProvider, TransportReceipt } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type MessageListenerSession,
	createMessageListenerSession,
} from "../src/commands/message-listen.js";
import { setCliRuntimeOverride } from "../src/lib/runtime-overrides.js";
import {
	LoopbackTransportNetwork,
	StaticAgentResolver,
	clearLoopbackRuntime,
	createResolvedAgentFixture,
	installLoopbackRuntime,
} from "./helpers/loopback-runtime.js";
import { runCli } from "./helpers/run-cli.js";

const CHAIN = "eip155:84532";
const TREASURY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const WORKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

interface PermissionSnapshot {
	granted_by_me: {
		grants: Array<{ grantId: string; status: string }>;
	};
	granted_by_peer: {
		grants: Array<{ grantId: string; status: string }>;
	};
}

describe("two-agent CLI E2E flow", () => {
	let tempRoot: string;
	let treasuryDir: string;
	let workerDir: string;
	let treasuryListener: MessageListenerSession | undefined;
	let workerListener: MessageListenerSession | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-cli-e2e-"));
		treasuryDir = join(tempRoot, "treasury");
		workerDir = join(tempRoot, "worker");
		await mkdir(treasuryDir, { recursive: true });
		await mkdir(workerDir, { recursive: true });

		const resolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: 7001,
				chain: CHAIN,
				privateKey: TREASURY_KEY,
				name: "TreasuryAgent",
				description: "Loopback treasury agent",
				capabilities: ["general-chat", "payments", "treasury"],
			}),
			createResolvedAgentFixture({
				agentId: 7002,
				chain: CHAIN,
				privateKey: WORKER_KEY,
				name: "WorkerAgent",
				description: "Loopback worker agent",
				capabilities: ["general-chat", "payments", "worker"],
			}),
		]);
		const network = new LoopbackTransportNetwork();

		installLoopbackRuntime({
			dataDir: treasuryDir,
			network,
			resolver,
			txHashPrefix: "a1",
		});
		installLoopbackRuntime({
			dataDir: workerDir,
			network,
			resolver,
			txHashPrefix: "b2",
		});
	});

	afterEach(async () => {
		await workerListener?.stop();
		await treasuryListener?.stop();
		clearLoopbackRuntime(workerDir);
		clearLoopbackRuntime(treasuryDir);
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("keeps the install, connect, grant, message, and funds flow working", async () => {
		const treasuryGrantsPath = await writeJsonFile(treasuryDir, "treasury-grants.json", {
			version: "tap-grants/v1",
			grants: [
				{ grantId: "worker-chat-from-treasury", scope: "general-chat" },
				{
					grantId: "worker-native-budget",
					scope: "transfer/request",
					constraints: {
						asset: "native",
						chain: CHAIN,
						maxAmount: "0.001",
						window: "week",
					},
				},
			],
		});
		const workerInitialRequestPath = await writeJsonFile(treasuryDir, "worker-request.json", {
			version: "tap-grants/v1",
			grants: [
				{ grantId: "worker-chat-from-treasury", scope: "general-chat" },
				{
					grantId: "worker-native-budget",
					scope: "transfer/request",
					constraints: {
						asset: "native",
						chain: CHAIN,
						maxAmount: "0.001",
						window: "week",
					},
				},
			],
		});
		const workerInitialOfferPath = await writeJsonFile(treasuryDir, "worker-offer.json", {
			version: "tap-grants/v1",
			grants: [{ grantId: "treasury-chat-from-worker", scope: "general-chat" }],
		});
		const followupRequestPath = await writeJsonFile(treasuryDir, "worker-followup.json", {
			version: "tap-grants/v1",
			grants: [{ grantId: "worker-research", scope: "research" }],
		});

		expect(
			await runCli([
				"--plain",
				"--data-dir",
				treasuryDir,
				"init",
				"--chain",
				"base-sepolia",
				"--private-key",
				TREASURY_KEY.slice(2),
			]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli([
				"--plain",
				"--data-dir",
				workerDir,
				"init",
				"--chain",
				"base-sepolia",
				"--private-key",
				WORKER_KEY.slice(2),
			]),
		).toMatchObject({ exitCode: 0 });

		expect(
			await runCli(["--json", "--data-dir", treasuryDir, "config", "set", "agent_id", "7001"]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli(["--json", "--data-dir", workerDir, "config", "set", "agent_id", "7002"]),
		).toMatchObject({ exitCode: 0 });

		const resolveSelf = await runCli([
			"--json",
			"--data-dir",
			treasuryDir,
			"identity",
			"resolve-self",
		]);
		expect(JSON.parse(resolveSelf.stdout).data.name).toBe("TreasuryAgent");

		const resolvePeer = await runCli([
			"--json",
			"--data-dir",
			treasuryDir,
			"identity",
			"resolve",
			"7002",
		]);
		expect(JSON.parse(resolvePeer.stdout).data.name).toBe("WorkerAgent");

		const invite = await runCli(["--json", "--data-dir", treasuryDir, "invite", "create"]);
		const inviteUrl = JSON.parse(invite.stdout).data.url as string;

		const connect = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"connect",
			inviteUrl,
			"--yes",
			"--request-grants-file",
			workerInitialRequestPath,
			"--grant-file",
			workerInitialOfferPath,
		]);
		expect(connect.exitCode).toBe(0);
		expect(connect.stdout).toContain("Requested Grants:");
		expect(connect.stdout).toContain("Offered Grants:");
		expect(connect.stdout).toContain("Status:         pending");
		expect(connect.stdout).toContain('"status": "queued"');

		const workerPendingContactBeforeSync = await runCli([
			"--json",
			"--data-dir",
			workerDir,
			"contacts",
			"list",
		]);
		expect(workerPendingContactBeforeSync.exitCode).toBe(0);
		expect(JSON.parse(workerPendingContactBeforeSync.stdout).data.contacts[0]?.status).toBe(
			"pending",
		);

		const syncTreasuryAfterOfflineConnect = await runCli([
			"--json",
			"--data-dir",
			treasuryDir,
			"message",
			"sync",
			"--yes",
		]);
		expect(syncTreasuryAfterOfflineConnect.exitCode).toBe(0);

		const inviteListAfterAcceptance = await runCli([
			"--json",
			"--data-dir",
			treasuryDir,
			"invite",
			"list",
		]);
		expect(inviteListAfterAcceptance.exitCode).toBe(0);
		expect(JSON.parse(inviteListAfterAcceptance.stdout).data.invites).toEqual([]);

		const syncWorkerAfterAcceptance = await runCli([
			"--json",
			"--data-dir",
			workerDir,
			"message",
			"sync",
			"--yes",
		]);
		expect(syncWorkerAfterAcceptance.exitCode).toBe(0);

		const contacts = await runCli(["--json", "--data-dir", treasuryDir, "contacts", "list"]);
		expect(JSON.parse(contacts.stdout).data.contacts).toHaveLength(1);
		expect(JSON.parse(contacts.stdout).data.contacts[0]?.status).toBe("active");

		const workerContacts = await runCli(["--json", "--data-dir", workerDir, "contacts", "list"]);
		expect(JSON.parse(workerContacts.stdout).data.contacts).toHaveLength(1);
		expect(JSON.parse(workerContacts.stdout).data.contacts[0]?.status).toBe("active");

		const initialTreasuryPermissions = await waitForPermissions(
			treasuryDir,
			"WorkerAgent",
			(data) =>
				data.granted_by_peer.grants.some((grant) => grant.grantId === "treasury-chat-from-worker"),
		);
		expect(initialTreasuryPermissions.granted_by_me.grants).toEqual([]);
		expect(initialTreasuryPermissions.granted_by_peer.grants.map((grant) => grant.grantId)).toEqual(
			["treasury-chat-from-worker"],
		);

		const requestMore = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"permissions",
			"request",
			"TreasuryAgent",
			"--file",
			followupRequestPath,
			"--note",
			"follow-up request",
		]);
		expect(requestMore.exitCode).toBe(0);
		expect(requestMore.stdout).toContain("Requested:    true");

		workerListener = await createMessageListenerSession(
			{ plain: true, dataDir: workerDir },
			{ yes: true },
			{},
		);
		treasuryListener = await createMessageListenerSession(
			{ plain: true, dataDir: treasuryDir },
			{ yes: true },
			{
				approveTransfer: async ({ activeTransferGrants }) => activeTransferGrants.length > 0,
			},
		);

		const grant = await runCli([
			"--plain",
			"--data-dir",
			treasuryDir,
			"permissions",
			"grant",
			"WorkerAgent",
			"--file",
			treasuryGrantsPath,
			"--note",
			"approved in deterministic e2e",
		]);
		expect(grant.exitCode).toBe(0);
		expect(grant.stdout).toContain("Published:    true");
		expect(grant.stdout).toMatch(/Queued:\s+true/);

		const workerPermissions = await waitForPermissions(
			workerDir,
			"TreasuryAgent",
			(data) =>
				data.granted_by_peer.grants.some(
					(grant) => grant.grantId === "worker-chat-from-treasury",
				) && data.granted_by_peer.grants.some((grant) => grant.grantId === "worker-native-budget"),
		);
		expect(
			workerPermissions.granted_by_peer.grants.map((grant) => ({
				id: grant.grantId,
				status: grant.status,
			})),
		).toEqual([
			{ id: "worker-chat-from-treasury", status: "active" },
			{ id: "worker-native-budget", status: "active" },
		]);

		const sendWorkerToTreasury = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"message",
			"send",
			"TreasuryAgent",
			"hello from worker",
			"--scope",
			"general-chat",
		]);
		expect(sendWorkerToTreasury.exitCode).toBe(0);
		expect(sendWorkerToTreasury.stdout).toContain("Sent:      true");
		expect(sendWorkerToTreasury.stdout).toMatch(/Queued:\s+true/);

		const sendTreasuryToWorker = await runCli([
			"--plain",
			"--data-dir",
			treasuryDir,
			"message",
			"send",
			"WorkerAgent",
			"hello from treasury",
			"--scope",
			"general-chat",
		]);
		expect(sendTreasuryToWorker.exitCode).toBe(0);
		expect(sendTreasuryToWorker.stdout).toContain("Sent:      true");
		expect(sendTreasuryToWorker.stdout).toMatch(/Queued:\s+true/);

		const approvedFundsRequest = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"message",
			"request-funds",
			"TreasuryAgent",
			"--asset",
			"native",
			"--amount",
			"0.0002",
			"--chain",
			"base-sepolia",
			"--note",
			"approved deterministic request",
		]);
		expect(approvedFundsRequest.exitCode).toBe(0);
		expect(approvedFundsRequest.stdout).toMatch(/Queued:\s+true/);
		expect(approvedFundsRequest.stdout).toContain("Status:                   completed");
		expect(approvedFundsRequest.stdout).toContain(
			"0xa100000000000000000000000000000000000000000000000000000000000000",
		);

		const revoke = await runCli([
			"--plain",
			"--data-dir",
			treasuryDir,
			"permissions",
			"revoke",
			"WorkerAgent",
			"--grant-id",
			"worker-native-budget",
			"--note",
			"revoked in deterministic e2e",
		]);
		expect(revoke.exitCode).toBe(0);
		expect(revoke.stdout).toContain("Revoked:   true");
		expect(revoke.stdout).toMatch(/Queued:\s+true/);

		const revokedPermissions = await waitForPermissions(workerDir, "TreasuryAgent", (data) =>
			data.granted_by_peer.grants.some(
				(grant) => grant.grantId === "worker-native-budget" && grant.status === "revoked",
			),
		);
		expect(
			revokedPermissions.granted_by_peer.grants.find(
				(grant) => grant.grantId === "worker-native-budget",
			)?.status,
		).toBe("revoked");

		const rejectedFundsRequest = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"message",
			"request-funds",
			"TreasuryAgent",
			"--asset",
			"native",
			"--amount",
			"0.0001",
			"--chain",
			"base-sepolia",
			"--note",
			"rejected deterministic request",
		]);
		expect([0, 5]).toContain(rejectedFundsRequest.exitCode);
		if (rejectedFundsRequest.exitCode === 5) {
			expect(rejectedFundsRequest.stderr).toContain("Action rejected by agent");
		}

		const treasuryConversations = JSON.parse(
			(
				await runCli([
					"--json",
					"--data-dir",
					treasuryDir,
					"conversations",
					"list",
					"--with",
					"WorkerAgent",
				])
			).stdout,
		).data.conversations as Array<{ id: string; messages: number }>;
		expect(treasuryConversations).toHaveLength(1);
		expect(treasuryConversations[0]!.messages).toBeGreaterThan(0);

		const workerTranscript = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"conversations",
			"show",
			treasuryConversations[0]!.id,
		]);
		expect(workerTranscript.exitCode).toBe(0);
		expect(workerTranscript.stdout).toContain("hello from worker");
		expect(workerTranscript.stdout).toContain("approved deterministic request");

		const treasuryLedger = await readFile(
			join(treasuryDir, "notes", "permissions-ledger.md"),
			"utf-8",
		);
		expect(treasuryLedger).toContain("grant-request-received");
		expect(treasuryLedger).toContain("transfer-completed");
		expect(treasuryLedger).toContain("transfer-rejected");

		const workerLedger = await readFile(join(workerDir, "notes", "permissions-ledger.md"), "utf-8");
		expect(workerLedger).toContain("grant-request-sent");
		expect(workerLedger).toContain("transfer-completed");
		expect(workerLedger).toContain("transfer-rejected");
	}, 20_000);

	it("reports the persisted connection id for pending connects", async () => {
		const pendingRoot = await mkdtemp(join(tmpdir(), "tap-cli-pending-"));
		const pendingConnectorDir = join(pendingRoot, "connector");
		await mkdir(pendingConnectorDir, { recursive: true });

		const pendingAgentId = 7010;
		const pendingAgent = createResolvedAgentFixture({
			agentId: pendingAgentId,
			chain: CHAIN,
			privateKey: TREASURY_KEY,
			name: "PendingPeer",
			description: "Pending peer agent",
			capabilities: ["general-chat"],
		});

		class PendingTransport implements TransportProvider {
			setHandlers(): void {}
			async start(): Promise<void> {}
			async stop(): Promise<void> {}
			async isReachable(): Promise<boolean> {
				return true;
			}
			async send(): Promise<TransportReceipt> {
				return {
					received: true,
					requestId: "pending-response",
					status: "queued",
					receivedAt: "2026-03-06T00:00:00.000Z",
				};
			}
		}

		try {
			setCliRuntimeOverride(pendingConnectorDir, {
				createContext: () => ({
					trustStore: new FileTrustStore(pendingConnectorDir),
					resolver: new StaticAgentResolver([pendingAgent]),
					conversationLogger: new FileConversationLogger(pendingConnectorDir),
					requestJournal: new FileRequestJournal(pendingConnectorDir),
				}),
				createTransport: () => new PendingTransport(),
			});

			expect(
				await runCli([
					"--plain",
					"--data-dir",
					pendingConnectorDir,
					"init",
					"--chain",
					"base-sepolia",
					"--private-key",
					WORKER_KEY.slice(2),
				]),
			).toMatchObject({ exitCode: 0 });
			expect(
				await runCli([
					"--json",
					"--data-dir",
					pendingConnectorDir,
					"config",
					"set",
					"agent_id",
					"7002",
				]),
			).toMatchObject({ exitCode: 0 });

			const invite = await generateInvite({
				agentId: pendingAgentId,
				chain: CHAIN,
				privateKey: TREASURY_KEY,
				expirySeconds: 3600,
			});

			const connect = await runCli([
				"--json",
				"--data-dir",
				pendingConnectorDir,
				"connect",
				invite.url,
				"--yes",
			]);
			expect(connect.exitCode).toBe(0);

			const output = JSON.parse(connect.stdout).data as {
				connection_id: string;
				status: string;
			};
			expect(output.status).toBe("pending");

			const trustStore = new FileTrustStore(pendingConnectorDir);
			const storedContacts = await trustStore.getContacts();
			expect(storedContacts).toHaveLength(1);
			expect(output.connection_id).toBe(storedContacts[0]?.connectionId);
			expect(output.connection_id).not.toBe(invite.nonce);
		} finally {
			clearLoopbackRuntime(pendingConnectorDir);
			await rm(pendingRoot, { recursive: true, force: true });
		}
	});

	it("queues connect behind a live listener and still converges to active", async () => {
		expect(
			await runCli([
				"--plain",
				"--data-dir",
				treasuryDir,
				"init",
				"--chain",
				"base-sepolia",
				"--private-key",
				TREASURY_KEY.slice(2),
			]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli([
				"--plain",
				"--data-dir",
				workerDir,
				"init",
				"--chain",
				"base-sepolia",
				"--private-key",
				WORKER_KEY.slice(2),
			]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli(["--json", "--data-dir", treasuryDir, "config", "set", "agent_id", "7001"]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli(["--json", "--data-dir", workerDir, "config", "set", "agent_id", "7002"]),
		).toMatchObject({ exitCode: 0 });

		const invite = await runCli(["--json", "--data-dir", treasuryDir, "invite", "create"]);
		const inviteUrl = JSON.parse(invite.stdout).data.url as string;

		treasuryListener = await createMessageListenerSession(
			{ plain: true, dataDir: treasuryDir },
			{ yes: true },
			{},
		);
		workerListener = await createMessageListenerSession(
			{ plain: true, dataDir: workerDir },
			{ yes: true },
			{},
		);

		const connect = await runCli([
			"--json",
			"--data-dir",
			workerDir,
			"connect",
			inviteUrl,
			"--yes",
		]);
		expect(connect.exitCode).toBe(0);
		const connectData = parseJsonEnvelope(connect.stdout).data as {
			status: string;
			queued?: boolean;
		};
		expect(connectData.queued).toBe(true);
		expect(["pending", "active"]).toContain(connectData.status);

		const treasuryContacts = await waitForContacts(treasuryDir, (contacts) =>
			contacts.some((contact) => contact.status === "active"),
		);
		expect(treasuryContacts[0]?.status).toBe("active");

		const workerContacts = await waitForContacts(workerDir, (contacts) =>
			contacts.some((contact) => contact.status === "active"),
		);
		expect(workerContacts[0]?.status).toBe("active");
	});
});

async function writeJsonFile(dir: string, name: string, value: unknown): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
	return path;
}

async function waitForPermissions(
	dataDir: string,
	peer: string,
	predicate: (data: PermissionSnapshot) => boolean,
	timeoutMs = 2_000,
): Promise<PermissionSnapshot> {
	const deadline = Date.now() + timeoutMs;
	let lastSnapshot: PermissionSnapshot | undefined;

	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "permissions", "show", peer]);
		if (result.exitCode === 0) {
			const data = JSON.parse(result.stdout).data as PermissionSnapshot;
			lastSnapshot = data;
			if (predicate(data)) {
				return data;
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(
		`Timed out waiting for permissions for ${peer}: ${JSON.stringify(lastSnapshot ?? null)}`,
	);
}

function parseJsonEnvelope(stdout: string): { ok: boolean; data: unknown } {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.includes('"ok"')) {
			continue;
		}
		return JSON.parse(trimmed) as { ok: boolean; data: unknown };
	}
	throw new Error(`No JSON envelope found in output: ${stdout}`);
}

async function waitForContacts(
	dataDir: string,
	predicate: (
		contacts: Array<{
			name: string;
			agent_id: number;
			status: string;
			connection_id: string;
		}>,
	) => boolean,
	timeoutMs = 3_000,
): Promise<
	Array<{
		name: string;
		agent_id: number;
		status: string;
		connection_id: string;
	}>
> {
	const deadline = Date.now() + timeoutMs;
	let lastContacts:
		| Array<{
				name: string;
				agent_id: number;
				status: string;
				connection_id: string;
		  }>
		| undefined;

	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
		if (result.exitCode === 0) {
			const contacts = (
				parseJsonEnvelope(result.stdout).data as {
					contacts: Array<{
						name: string;
						agent_id: number;
						status: string;
						connection_id: string;
					}>;
				}
			).contacts;
			lastContacts = contacts;
			if (predicate(contacts)) {
				return contacts;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(
		`Timed out waiting for contacts in ${dataDir}: ${JSON.stringify(lastContacts ?? [])}`,
	);
}
