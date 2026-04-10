import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	generateInvite,
} from "trusted-agents-core";
import type { SigningProvider, TransportProvider, TransportReceipt } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type MessageListenerSession,
	createMessageListenerSession,
} from "../../src/commands/message-listen.js";
import { clearCliRuntimeOverride, setCliRuntimeOverride } from "../../src/lib/runtime-overrides.js";
import {
	LoopbackTransportNetwork,
	StaticAgentResolver,
	clearLoopbackRuntime,
	createResolvedAgentFixture,
	installLoopbackRuntime,
} from "../helpers/loopback-runtime.js";
import { runCli } from "../helpers/run-cli.js";
import { type PermissionSnapshot, parseJsonOutput, writeGrantFile } from "./helpers.js";
import { SCENARIOS } from "./scenarios.js";

// ── Keys & addresses ─────────────────────────────────────────────────────────

const CHAIN = "eip155:8453";
const AGENT_A_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const AGENT_B_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const AGENT_A_ADDRESS = privateKeyToAccount(AGENT_A_KEY).address;
const AGENT_B_ADDRESS = privateKeyToAccount(AGENT_B_KEY).address;
const AGENT_A_ID = 7001;
const AGENT_B_ID = 7002;
const AGENT_A_NAME = "E2E-Agent-A-mock";
const AGENT_B_NAME = "E2E-Agent-B-mock";
const GRANT_ID = "e2e-usdc-transfer";

// ── Signing providers ────────────────────────────────────────────────────────

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

const agentASigningProvider = createTestSigningProvider(AGENT_A_KEY);
const agentBSigningProvider = createTestSigningProvider(AGENT_B_KEY);

// ── OWS mock ─────────────────────────────────────────────────────────────────

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: class MockOwsSigningProvider {
			private provider: SigningProvider;
			constructor(wallet: string) {
				this.provider = wallet === "agent-b-wallet" ? agentBSigningProvider : agentASigningProvider;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function waitForPermissionsMock(
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
			const data = (JSON.parse(result.stdout) as { data: PermissionSnapshot }).data;
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

// ── Shared state ──────────────────────────────────────────────────────────────

let tempRoot: string;
let agentADir: string;
let agentBDir: string;
let inviteUrl: string;
let agentAListener: MessageListenerSession | undefined;
let agentBListener: MessageListenerSession | undefined;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("TAP mocked E2E — loopback transport + static resolver", { timeout: 20_000 }, () => {
	beforeAll(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-e2e-mock-"));
		agentADir = join(tempRoot, "agent-a");
		agentBDir = join(tempRoot, "agent-b");
		await mkdir(agentADir, { recursive: true });
		await mkdir(agentBDir, { recursive: true });

		const resolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: AGENT_A_ID,
				chain: CHAIN,
				address: AGENT_A_ADDRESS,
				name: AGENT_A_NAME,
				description: "Loopback E2E agent A",
				capabilities: ["general-chat", "payments"],
			}),
			createResolvedAgentFixture({
				agentId: AGENT_B_ID,
				chain: CHAIN,
				address: AGENT_B_ADDRESS,
				name: AGENT_B_NAME,
				description: "Loopback E2E agent B",
				capabilities: ["general-chat", "payments"],
			}),
		]);

		const network = new LoopbackTransportNetwork();

		installLoopbackRuntime({
			dataDir: agentADir,
			network,
			resolver,
			txHashPrefix: "a1",
		});
		installLoopbackRuntime({
			dataDir: agentBDir,
			network,
			resolver,
			txHashPrefix: "b2",
		});
	});

	afterAll(async () => {
		await agentBListener?.stop();
		await agentAListener?.stop();
		clearLoopbackRuntime(agentBDir);
		clearLoopbackRuntime(agentADir);
		await rm(tempRoot, { recursive: true, force: true });
	});

	// ── Phase 1: Onboarding ───────────────────────────────────────────────────

	describe("Phase 1: Onboarding", () => {
		it(SCENARIOS.INIT_AGENT_A.name, async () => {
			const result = await runCli(["--plain", "--data-dir", agentADir, "init", "--chain", "base"]);
			expect(result.exitCode, `Agent A init failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.INIT_AGENT_B.name, async () => {
			const result = await runCli(["--plain", "--data-dir", agentBDir, "init", "--chain", "base"]);
			expect(result.exitCode, `Agent B init failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.RESOLVE_AGENT_A.name, async () => {
			await setOwsConfig(agentADir, "agent-a-wallet", "agent-a-key", AGENT_A_ID);

			const result = await runCli(["--json", "--data-dir", agentADir, "identity", "resolve-self"]);
			expect(result.exitCode, `Agent A resolve-self failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string };
			expect(data.name, "Agent A resolved name should match fixture").toBe(AGENT_A_NAME);
		});

		it(SCENARIOS.RESOLVE_AGENT_B.name, async () => {
			await setOwsConfig(agentBDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			const result = await runCli(["--json", "--data-dir", agentBDir, "identity", "resolve-self"]);
			expect(result.exitCode, `Agent B resolve-self failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string };
			expect(data.name, "Agent B resolved name should match fixture").toBe(AGENT_B_NAME);
		});
	});

	// ── Phase 2: Connection ───────────────────────────────────────────────────

	describe("Phase 2: Connection", () => {
		it(SCENARIOS.CREATE_INVITE.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "invite", "create"]);
			expect(result.exitCode, `Agent A invite create failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { url: string };
			expect(data.url, "Invite URL should be defined").toBeTruthy();
			inviteUrl = data.url;
		});

		it(SCENARIOS.ACCEPT_INVITE.name, async () => {
			expect(inviteUrl, "Invite URL must be set from previous test").toBeTruthy();

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"connect",
				inviteUrl,
				"--yes",
			]);
			expect(result.exitCode, `Agent B connect failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Status:");
		});

		it(SCENARIOS.SYNC_CONNECTION_A.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "message", "sync"]);
			expect(result.exitCode, `Agent A sync failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_CONNECTION_B.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentBDir, "message", "sync"]);
			expect(result.exitCode, `Agent B sync failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.VERIFY_CONTACTS_A.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "contacts", "list"]);
			expect(result.exitCode).toBe(0);
			const contacts = (
				JSON.parse(result.stdout) as { data: { contacts: Array<{ name: string; status: string }> } }
			).data.contacts;
			const contact = contacts.find((c) => c.name === AGENT_B_NAME);
			expect(contact, `Agent B contact should exist in Agent A's contacts`).toBeDefined();
			expect(contact?.status, "Agent A should have active contact with Agent B").toBe("active");
		});

		it(SCENARIOS.VERIFY_CONTACTS_B.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentBDir, "contacts", "list"]);
			expect(result.exitCode).toBe(0);
			const contacts = (
				JSON.parse(result.stdout) as { data: { contacts: Array<{ name: string; status: string }> } }
			).data.contacts;
			const contact = contacts.find((c) => c.name === AGENT_A_NAME);
			expect(contact, `Agent A contact should exist in Agent B's contacts`).toBeDefined();
			expect(contact?.status, "Agent B should have active contact with Agent A").toBe("active");
		});
	});

	// ── Phase 3: Permissions ──────────────────────────────────────────────────

	describe("Phase 3: Permissions", () => {
		it(SCENARIOS.VERIFY_NO_GRANTS.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"permissions",
				"show",
				AGENT_A_NAME,
			]);
			expect(result.exitCode, `permissions show failed:\n${result.stderr}`).toBe(0);

			const parsed = JSON.parse(result.stdout) as { data: PermissionSnapshot };
			expect(
				parsed.data.granted_by_peer.grants,
				"Agent B should have no grants from Agent A before granting",
			).toEqual([]);
		});

		it(SCENARIOS.GRANT_TRANSFER.name, async () => {
			// Start listeners BEFORE grant so transfer auto-approval hook is active
			agentAListener = await createMessageListenerSession(
				{ plain: true, dataDir: agentADir },
				{
					approveTransfer: async ({ activeTransferGrants }) => activeTransferGrants.length > 0,
				},
			);
			agentBListener = await createMessageListenerSession({ plain: true, dataDir: agentBDir }, {});

			const grantFilePath = await writeGrantFile(agentADir, "transfer-grant.json", [
				{
					grantId: GRANT_ID,
					scope: "transfer/request",
					constraints: {
						asset: "native",
						chain: CHAIN,
						maxAmount: "0.001",
					},
				},
			]);

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"permissions",
				"grant",
				AGENT_B_NAME,
				"--file",
				grantFilePath,
				"--note",
				"e2e mock transfer grant",
			]);
			expect(result.exitCode, `Agent A permissions grant failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Published:    true");
		});

		it(SCENARIOS.VERIFY_GRANT.name, async () => {
			const snapshot = await waitForPermissionsMock(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "active"),
				2_000,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant, `Grant "${GRANT_ID}" should be visible to Agent B`).toBeDefined();
			expect(grant?.status, `Grant "${GRANT_ID}" should be active`).toBe("active");
		});
	});

	// ── Phase 4: Messaging ────────────────────────────────────────────────────

	describe("Phase 4: Messaging", () => {
		it(SCENARIOS.SEND_MESSAGE_A_TO_B.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"ping from agent A",
				"--scope",
				"general-chat",
			]);
			expect(result.exitCode, `Agent A message send failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Sent:      true");
		});

		it(SCENARIOS.SEND_MESSAGE_B_TO_A.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"send",
				AGENT_A_NAME,
				"pong from agent B",
				"--scope",
				"general-chat",
			]);
			expect(result.exitCode, `Agent B message send failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Sent:      true");
		});

		it(SCENARIOS.VERIFY_CONVERSATIONS.name, async () => {
			// With loopback listeners active, messages are delivered instantly through the listener.
			// A sync pass ensures any queued messages from non-listener sends are also processed.
			await runCli(["--json", "--data-dir", agentADir, "message", "sync"]);
			await runCli(["--json", "--data-dir", agentBDir, "message", "sync"]);

			const aResult = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"conversations",
				"list",
				"--with",
				AGENT_B_NAME,
			]);
			expect(aResult.exitCode, `Agent A conversations list failed:\n${aResult.stderr}`).toBe(0);
			const aConvos = (
				JSON.parse(aResult.stdout) as {
					data: { conversations: Array<{ id: string; messages: number }> };
				}
			).data.conversations;
			expect(
				aConvos.length,
				"Agent A should have at least one conversation with Agent B",
			).toBeGreaterThan(0);
			expect(
				aConvos[0]!.messages,
				"Agent A conversation should contain at least one message",
			).toBeGreaterThan(0);

			const bResult = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"conversations",
				"list",
				"--with",
				AGENT_A_NAME,
			]);
			expect(bResult.exitCode, `Agent B conversations list failed:\n${bResult.stderr}`).toBe(0);
			const bConvos = (
				JSON.parse(bResult.stdout) as {
					data: { conversations: Array<{ id: string; messages: number }> };
				}
			).data.conversations;
			expect(
				bConvos.length,
				"Agent B should have at least one conversation with Agent A",
			).toBeGreaterThan(0);
			expect(
				bConvos[0]!.messages,
				"Agent B conversation should contain at least one message",
			).toBeGreaterThan(0);
		});
	});

	// ── Phase 5: Transfers ────────────────────────────────────────────────────

	describe("Phase 5: Transfers", () => {
		it(SCENARIOS.REQUEST_FUNDS_APPROVED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"request-funds",
				AGENT_A_NAME,
				"--asset",
				"native",
				"--amount",
				"0.0002",
				"--chain",
				"base",
				"--note",
				"e2e mock approved transfer",
			]);
			expect(result.exitCode, `Agent B request-funds failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Status:                   completed");
			expect(result.stdout).toContain(
				"0xa100000000000000000000000000000000000000000000000000000000000000",
			);
		});

		it(SCENARIOS.REVOKE_GRANT.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"permissions",
				"revoke",
				AGENT_B_NAME,
				"--grant-id",
				GRANT_ID,
				"--note",
				"e2e mock revoke after transfer test",
			]);
			expect(result.exitCode, `Agent A permissions revoke failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Revoked:   true");
		});

		it(SCENARIOS.SYNC_REVOCATION.name, async () => {
			const snapshot = await waitForPermissionsMock(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "revoked"),
				2_000,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant?.status, `Grant "${GRANT_ID}" should be revoked`).toBe("revoked");
		});

		it(SCENARIOS.REQUEST_FUNDS_REJECTED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"request-funds",
				AGENT_A_NAME,
				"--asset",
				"native",
				"--amount",
				"0.0001",
				"--chain",
				"base",
				"--note",
				"e2e mock rejected transfer (no grant)",
			]);
			// Accept exit code 0 (queued) or 3 (immediately rejected)
			expect(
				[0, 3].includes(result.exitCode),
				`Expected exit code 0 or 3, got ${result.exitCode}:\n${result.stderr}`,
			).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════
	// Edge case: pending outbound connect without contact
	// ═══════════════════════════════════════════════════════

	it("persists pending outbound connects without creating a contact", async () => {
		const pendingRoot = await mkdtemp(join(tmpdir(), "tap-e2e-pending-"));
		const pendingDir = join(pendingRoot, "connector");
		await mkdir(pendingDir, { recursive: true });

		const pendingAgentId = 7010;
		const pendingAgent = createResolvedAgentFixture({
			agentId: pendingAgentId,
			chain: CHAIN,
			address: AGENT_A_ADDRESS,
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
			setCliRuntimeOverride(pendingDir, {
				createContext: () => ({
					trustStore: new FileTrustStore(pendingDir),
					resolver: new StaticAgentResolver([pendingAgent]),
					conversationLogger: new FileConversationLogger(pendingDir),
					requestJournal: new FileRequestJournal(pendingDir),
				}),
				createTransport: () => new PendingTransport(),
			});

			expect(
				await runCli(["--plain", "--data-dir", pendingDir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			await setOwsConfig(pendingDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			const invite = await generateInvite({
				agentId: pendingAgentId,
				chain: CHAIN,
				signingProvider: agentASigningProvider,
				expirySeconds: 3600,
			});

			const connect = await runCli([
				"--json",
				"--data-dir",
				pendingDir,
				"connect",
				invite.url,
				"--yes",
			]);
			expect(connect.exitCode).toBe(0);

			const output = parseJsonOutput(connect.stdout).data as {
				connection_id?: string;
				status: string;
			};
			expect(output.status).toBe("pending");
			// connection_id is now defined — the connecting contact is written
			// to the trust store before any wire traffic (spec §1.1).
			expect(output.connection_id).toBeDefined();

			const trustStore = new FileTrustStore(pendingDir);
			const contacts = await trustStore.getContacts();
			expect(contacts).toHaveLength(1);
			expect(contacts[0]).toMatchObject({
				peerAgentId: pendingAgentId,
				status: "connecting",
			});
		} finally {
			clearCliRuntimeOverride(pendingDir);
			await rm(pendingRoot, { recursive: true, force: true });
		}
	});

	// ═══════════════════════════════════════════════════════
	// Edge case: connect queued behind live listener
	// ═══════════════════════════════════════════════════════

	it("queues connect behind a live listener and still converges to active", async () => {
		const queueRoot = await mkdtemp(join(tmpdir(), "tap-e2e-queue-"));
		const queueADir = join(queueRoot, "agent-a");
		const queueBDir = join(queueRoot, "agent-b");
		await mkdir(queueADir, { recursive: true });
		await mkdir(queueBDir, { recursive: true });

		const queueNetwork = new LoopbackTransportNetwork();
		const queueResolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: AGENT_A_ID,
				chain: CHAIN,
				address: AGENT_A_ADDRESS,
				name: AGENT_A_NAME,
				description: "Queue test Agent A",
				capabilities: ["general-chat"],
			}),
			createResolvedAgentFixture({
				agentId: AGENT_B_ID,
				chain: CHAIN,
				address: AGENT_B_ADDRESS,
				name: AGENT_B_NAME,
				description: "Queue test Agent B",
				capabilities: ["general-chat"],
			}),
		]);

		installLoopbackRuntime({
			dataDir: queueADir,
			network: queueNetwork,
			resolver: queueResolver,
			txHashPrefix: "c1",
		});
		installLoopbackRuntime({
			dataDir: queueBDir,
			network: queueNetwork,
			resolver: queueResolver,
			txHashPrefix: "d2",
		});

		let listenerA: MessageListenerSession | undefined;
		let listenerB: MessageListenerSession | undefined;

		try {
			expect(
				await runCli(["--plain", "--data-dir", queueADir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			expect(
				await runCli(["--plain", "--data-dir", queueBDir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			await setOwsConfig(queueADir, "agent-a-wallet", "agent-a-key", AGENT_A_ID);
			await setOwsConfig(queueBDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			const invite = await runCli(["--json", "--data-dir", queueADir, "invite", "create"]);
			const inviteUrl = parseJsonOutput(invite.stdout).data as { url: string };

			// Start listeners BEFORE connect — connect must queue behind them
			listenerA = await createMessageListenerSession({ plain: true, dataDir: queueADir }, {});
			listenerB = await createMessageListenerSession({ plain: true, dataDir: queueBDir }, {});

			const connect = await runCli([
				"--json",
				"--data-dir",
				queueBDir,
				"connect",
				inviteUrl.url,
				"--yes",
			]);
			expect(connect.exitCode).toBe(0);
			const connectData = parseJsonOutput(connect.stdout).data as {
				status: string;
				queued?: boolean;
			};
			expect(connectData.queued).toBe(true);
			expect(["pending", "active"]).toContain(connectData.status);

			// Poll until both sides converge to active
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline) {
				const aContacts = await runCli(["--json", "--data-dir", queueADir, "contacts", "list"]);
				const bContacts = await runCli(["--json", "--data-dir", queueBDir, "contacts", "list"]);
				const aList = (
					parseJsonOutput(aContacts.stdout).data as {
						contacts: Array<{ status: string }>;
					}
				).contacts;
				const bList = (
					parseJsonOutput(bContacts.stdout).data as {
						contacts: Array<{ status: string }>;
					}
				).contacts;

				if (aList.some((c) => c.status === "active") && bList.some((c) => c.status === "active")) {
					break;
				}
				await new Promise((r) => setTimeout(r, 25));
			}

			// Final assertions
			const finalA = await runCli(["--json", "--data-dir", queueADir, "contacts", "list"]);
			const finalB = await runCli(["--json", "--data-dir", queueBDir, "contacts", "list"]);
			const contactsA = (
				parseJsonOutput(finalA.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			const contactsB = (
				parseJsonOutput(finalB.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			expect(contactsA[0]?.status).toBe("active");
			expect(contactsB[0]?.status).toBe("active");
		} finally {
			await listenerB?.stop();
			await listenerA?.stop();
			clearLoopbackRuntime(queueBDir);
			clearLoopbackRuntime(queueADir);
			await rm(queueRoot, { recursive: true, force: true });
		}
	});
});
