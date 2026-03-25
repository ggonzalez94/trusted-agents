import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	generateInvite,
} from "trusted-agents-core";
import type {
	AvailabilityWindow,
	CalendarEvent,
	ICalendarProvider,
	SigningProvider,
	TransportProvider,
	TransportReceipt,
} from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

class MockCalendarProvider implements ICalendarProvider {
	public createdEvents: CalendarEvent[] = [];
	public cancelledEventIds: string[] = [];
	private readonly availability: AvailabilityWindow[];

	constructor(availability: AvailabilityWindow[]) {
		this.availability = availability;
	}

	async getAvailability(): Promise<AvailabilityWindow[]> {
		return this.availability;
	}

	async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
		this.createdEvents.push(event);
		return { eventId: `mock-event-${this.createdEvents.length}` };
	}

	async cancelEvent(eventId: string): Promise<void> {
		this.cancelledEventIds.push(eventId);
	}
}

const CHAIN = "eip155:8453";
const TREASURY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const WORKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TREASURY_ADDRESS = privateKeyToAccount(TREASURY_KEY).address;
const WORKER_ADDRESS = privateKeyToAccount(WORKER_KEY).address;

function createTestSigningProvider(key: `0x${string}`): SigningProvider {
	const account = privateKeyToAccount(key);
	return {
		getAddress: async () => account.address,
		signMessage: async (message) => await account.signMessage({ message }),
		signTypedData: async (params) =>
			await account.signTypedData({
				domain: params.domain as Record<string, unknown>,
				types: params.types as Record<string, readonly { name: string; type: string }[]>,
				primaryType: params.primaryType,
				message: params.message as Record<string, unknown>,
			}),
		signTransaction: async (tx) => await account.signTransaction(tx as never),
		signAuthorization: async () => {
			throw new Error("not implemented in test");
		},
	};
}

const treasurySigningProvider = createTestSigningProvider(TREASURY_KEY);
const workerSigningProvider = createTestSigningProvider(WORKER_KEY);

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: class MockOwsSigningProvider {
			private provider: SigningProvider;
			constructor(wallet: string) {
				this.provider =
					wallet === "worker-wallet" ? workerSigningProvider : treasurySigningProvider;
			}
			getAddress() {
				return this.provider.getAddress();
			}
			signMessage(msg: unknown) {
				return this.provider.signMessage(msg as never);
			}
			signTypedData(params: unknown) {
				return this.provider.signTypedData(params as never);
			}
			signTransaction(tx: unknown) {
				return this.provider.signTransaction(tx as never);
			}
			signAuthorization(params: unknown) {
				return this.provider.signAuthorization(params as never);
			}
		},
	};
});

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
	let treasuryCalendar: MockCalendarProvider;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-cli-e2e-"));
		treasuryDir = join(tempRoot, "treasury");
		workerDir = join(tempRoot, "worker");
		await mkdir(treasuryDir, { recursive: true });
		await mkdir(workerDir, { recursive: true });

		// Treasury calendar returns a wide free window covering the test proposal time
		treasuryCalendar = new MockCalendarProvider([
			{ start: "2026-03-28T20:00:00Z", end: "2026-03-29T04:00:00Z", status: "free" },
		]);

		const resolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: 7001,
				chain: CHAIN,
				address: TREASURY_ADDRESS,
				name: "TreasuryAgent",
				description: "Loopback treasury agent",
				capabilities: ["general-chat", "payments", "treasury"],
			}),
			createResolvedAgentFixture({
				agentId: 7002,
				chain: CHAIN,
				address: WORKER_ADDRESS,
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
			calendarProvider: treasuryCalendar,
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
				{
					grantId: "worker-scheduling",
					scope: "scheduling/request",
					constraints: {
						maxDurationMinutes: 180,
					},
				},
			],
		});
		const followupRequestPath = await writeJsonFile(treasuryDir, "worker-followup.json", {
			version: "tap-grants/v1",
			grants: [{ grantId: "worker-research", scope: "research" }],
		});

		expect(
			await runCli(["--plain", "--data-dir", treasuryDir, "init", "--chain", "base"]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli(["--plain", "--data-dir", workerDir, "init", "--chain", "base"]),
		).toMatchObject({ exitCode: 0 });

		await setOwsConfig(treasuryDir, "treasury-wallet", "treasury-key", 7001);
		await setOwsConfig(workerDir, "worker-wallet", "worker-key", 7002);

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
		]);
		expect(connect.exitCode).toBe(0);
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
		expect(JSON.parse(workerPendingContactBeforeSync.stdout).data.contacts).toEqual([]);

		const syncTreasuryAfterOfflineConnect = await runCli([
			"--json",
			"--data-dir",
			treasuryDir,
			"message",
			"sync",
		]);
		expect(syncTreasuryAfterOfflineConnect.exitCode).toBe(0);

		const syncWorkerAfterAcceptance = await runCli([
			"--json",
			"--data-dir",
			workerDir,
			"message",
			"sync",
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
			(data) => data.granted_by_peer.grants.length === 0,
		);
		expect(initialTreasuryPermissions.granted_by_me.grants).toEqual([]);
		expect(initialTreasuryPermissions.granted_by_peer.grants).toEqual([]);

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

		workerListener = await createMessageListenerSession({ plain: true, dataDir: workerDir }, {});
		treasuryListener = await createMessageListenerSession(
			{ plain: true, dataDir: treasuryDir },
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
				) &&
				data.granted_by_peer.grants.some((grant) => grant.grantId === "worker-native-budget") &&
				data.granted_by_peer.grants.some((grant) => grant.grantId === "worker-scheduling"),
		);
		expect(
			workerPermissions.granted_by_peer.grants.map((grant) => ({
				id: grant.grantId,
				status: grant.status,
			})),
		).toEqual([
			{ id: "worker-chat-from-treasury", status: "active" },
			{ id: "worker-native-budget", status: "active" },
			{ id: "worker-scheduling", status: "active" },
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
			"base",
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
			"base",
			"--note",
			"rejected deterministic request",
		]);
		expect([0, 5]).toContain(rejectedFundsRequest.exitCode);
		if (rejectedFundsRequest.exitCode === 5) {
			expect(rejectedFundsRequest.stderr).toContain("Action rejected by agent");
		}

		// === Scheduling: worker requests meeting with treasury ===

		const meetingRequest = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"message",
			"request-meeting",
			"TreasuryAgent",
			"--title",
			"Dinner",
			"--duration",
			"90",
			"--preferred",
			"2026-03-28T23:00:00Z",
			"--note",
			"deterministic scheduling test",
		]);
		expect(meetingRequest.exitCode).toBe(0);
		expect(meetingRequest.stdout).toMatch(/Requested:\s+true/);
		expect(meetingRequest.stdout).toContain("Dinner");
		expect(meetingRequest.stdout).toMatch(/Queued:\s+true/);

		// Treasury listener should have auto-processed the scheduling request:
		//  1. Grant matched (worker-scheduling covers 90min < 180min)
		//  2. Calendar returned free availability overlapping the proposed slot
		//  3. confirmMeeting hook returns true in non-TTY
		//  4. MockCalendarProvider.createEvent was called
		// Give the async processing a moment to settle.
		await waitForCondition(
			async () => treasuryCalendar.createdEvents.length > 0,
			"treasury calendar to have a created event",
		);

		expect(treasuryCalendar.createdEvents).toHaveLength(1);
		expect(treasuryCalendar.createdEvents[0]!.title).toBe("Dinner");
		expect(treasuryCalendar.createdEvents[0]!.start).toBe("2026-03-28T23:00:00.000Z");

		// Worker should receive the scheduling/accept result via its listener
		// The result updates the request journal to "completed" and appends ledger entries
		const workerLedgerAfterScheduling = await waitForCondition(async () => {
			try {
				const content = await readFile(join(workerDir, "notes", "permissions-ledger.md"), "utf-8");
				return content.includes("scheduling-accept") ? content : null;
			} catch {
				return null;
			}
		}, "worker ledger to contain scheduling-accept");
		expect(workerLedgerAfterScheduling).toContain("scheduling-request-sent");
		expect(workerLedgerAfterScheduling).toContain("scheduling-accept");

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
		const workerConversations = JSON.parse(
			(
				await runCli([
					"--json",
					"--data-dir",
					workerDir,
					"conversations",
					"list",
					"--with",
					"TreasuryAgent",
				])
			).stdout,
		).data.conversations as Array<{ id: string; messages: number }>;
		expect(workerConversations).toHaveLength(1);
		expect(workerConversations[0]!.messages).toBeGreaterThan(0);

		const workerTranscript = await runCli([
			"--plain",
			"--data-dir",
			workerDir,
			"conversations",
			"show",
			workerConversations[0]!.id,
		]);
		expect(workerTranscript.exitCode).toBe(0);
		expect(workerTranscript.stdout).toContain("hello from worker");
		expect(workerTranscript.stdout).toContain("approved deterministic request");
		expect(workerTranscript.stdout).toContain("Dinner");

		const treasuryLedger = await readFile(
			join(treasuryDir, "notes", "permissions-ledger.md"),
			"utf-8",
		);
		expect(treasuryLedger).toContain("grant-request-received");
		expect(treasuryLedger).toContain("transfer-completed");
		expect(treasuryLedger).toContain("transfer-rejected");
		expect(treasuryLedger).toContain("scheduling-accepted");

		const workerLedger = await readFile(join(workerDir, "notes", "permissions-ledger.md"), "utf-8");
		expect(workerLedger).toContain("grant-request-sent");
		expect(workerLedger).toContain("transfer-completed");
		expect(workerLedger).toContain("transfer-rejected");
		expect(workerLedger).toContain("scheduling-request-sent");
		expect(workerLedger).toContain("scheduling-accept");
	}, 20_000);

	it("persists pending outbound connects without creating a contact", async () => {
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
				await runCli(["--plain", "--data-dir", pendingConnectorDir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			await setOwsConfig(pendingConnectorDir, "worker-wallet", "worker-key", 7002);

			const invite = await generateInvite({
				agentId: pendingAgentId,
				chain: CHAIN,
				signingProvider: treasurySigningProvider,
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
				connection_id?: string;
				status: string;
			};
			expect(output.status).toBe("pending");
			expect(output.connection_id).toBeUndefined();

			const trustStore = new FileTrustStore(pendingConnectorDir);
			expect(await trustStore.getContacts()).toEqual([]);
			const pendingConnects = JSON.parse(
				await readFile(join(pendingConnectorDir, "pending-connects.json"), "utf-8"),
			) as { pendingConnects?: Array<{ peerAgentId: number }> };
			expect(pendingConnects.pendingConnects).toEqual([
				expect.objectContaining({ peerAgentId: pendingAgentId }),
			]);
		} finally {
			clearLoopbackRuntime(pendingConnectorDir);
			await rm(pendingRoot, { recursive: true, force: true });
		}
	});

	it("queues connect behind a live listener and still converges to active", async () => {
		expect(
			await runCli(["--plain", "--data-dir", treasuryDir, "init", "--chain", "base"]),
		).toMatchObject({ exitCode: 0 });
		expect(
			await runCli(["--plain", "--data-dir", workerDir, "init", "--chain", "base"]),
		).toMatchObject({ exitCode: 0 });
		await setOwsConfig(treasuryDir, "treasury-wallet", "treasury-key", 7001);
		await setOwsConfig(workerDir, "worker-wallet", "worker-key", 7002);

		const invite = await runCli(["--json", "--data-dir", treasuryDir, "invite", "create"]);
		const inviteUrl = JSON.parse(invite.stdout).data.url as string;

		treasuryListener = await createMessageListenerSession(
			{ plain: true, dataDir: treasuryDir },
			{},
		);
		workerListener = await createMessageListenerSession({ plain: true, dataDir: workerDir }, {});

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

async function waitForCondition<T>(
	check: () => Promise<T | null | false | undefined>,
	description: string,
	timeoutMs = 3_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const result = await check();
		if (result) {
			return result;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(`Timed out waiting for ${description}`);
}

async function setOwsConfig(
	dataDir: string,
	walletName: string,
	apiKey: string,
	agentId: number,
): Promise<void> {
	const configPath = join(dataDir, "config.yaml");
	const { default: YAML } = await import("yaml");
	const content = await readFile(configPath, "utf-8");
	const yaml = YAML.parse(content) as Record<string, unknown>;
	yaml.agent_id = agentId;
	yaml.ows = { wallet: walletName, api_key: apiKey };
	await writeFile(configPath, YAML.stringify(yaml), "utf-8");
}
