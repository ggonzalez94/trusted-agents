import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentResolver } from "../../src/identity/resolver.js";
import type { ProtocolMessage } from "../../src/transport/interface.js";
import { XmtpTransport } from "../../src/transport/xmtp.js";
import { FileTrustStore } from "../../src/trust/file-trust-store.js";
import type { Contact } from "../../src/trust/types.js";
import { ALICE_PRIVATE_KEY, BOB_PRIVATE_KEY } from "../fixtures/test-keys.js";

const XMTP_ENABLED = process.env.XMTP_INTEGRATION === "true";
const CAROL_PRIVATE_KEY =
	"0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const ALICE_ADDRESS = privateKeyToAccount(ALICE_PRIVATE_KEY).address;
const BOB_ADDRESS = privateKeyToAccount(BOB_PRIVATE_KEY).address;

function contact(args: {
	connectionId: string;
	peerAgentId: number;
	peerAddress: `0x${string}`;
	name: string;
}): Contact {
	const now = new Date().toISOString();
	return {
		connectionId: args.connectionId,
		peerAgentId: args.peerAgentId,
		peerChain: "eip155:1",
		peerOwnerAddress: args.peerAddress,
		peerDisplayName: args.name,
		peerAgentAddress: args.peerAddress,
		permissions: { "message/send": true },
		establishedAt: now,
		lastContactAt: now,
		status: "active",
	};
}

describe.skipIf(!XMTP_ENABLED)("XmtpTransport integration", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "xmtp-transport-int-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("should exchange JSON-RPC request/response between two transports", async () => {
		const aliceStore = new FileTrustStore(join(testDir, "alice"));
		const bobStore = new FileTrustStore(join(testDir, "bob"));

		await aliceStore.addContact(
			contact({
				connectionId: "alice-bob-001",
				peerAgentId: 2,
				peerAddress: BOB_ADDRESS,
				name: "Bob",
			}),
		);
		await bobStore.addContact(
			contact({
				connectionId: "bob-alice-001",
				peerAgentId: 1,
				peerAddress: ALICE_ADDRESS,
				name: "Alice",
			}),
		);

		const aliceTransport = new XmtpTransport(
			{
				privateKey: ALICE_PRIVATE_KEY,
				chain: "eip155:1",
				env: "dev",
				dbPath: join(testDir, "db-alice"),
				defaultResponseTimeoutMs: 45_000,
			},
			aliceStore,
		);

		const bobTransport = new XmtpTransport(
			{
				privateKey: BOB_PRIVATE_KEY,
				chain: "eip155:1",
				env: "dev",
				dbPath: join(testDir, "db-bob"),
				defaultResponseTimeoutMs: 45_000,
			},
			bobStore,
		);

		try {
			bobTransport.onMessage(async (_from: number, message: ProtocolMessage) => ({
				jsonrpc: "2.0",
				id: message.id,
				result: { pong: true },
			}));

			await Promise.all([aliceTransport.start(), bobTransport.start()]);

			const response = await aliceTransport.send(
				2,
				{
					jsonrpc: "2.0",
					method: "test/ping",
					id: "xmtp-int-1",
					params: { hello: "world" },
				},
				{ timeout: 45_000 },
			);

			expect(response.error).toBeUndefined();
			expect(response.result).toEqual({ pong: true });
		} finally {
			await Promise.all([aliceTransport.stop(), bobTransport.stop()]);
		}
	}, 90_000);

	it("should reject spoofed bootstrap sender identity", async () => {
		const bobStore = new FileTrustStore(join(testDir, "bob"));
		const carolStore = new FileTrustStore(join(testDir, "carol"));

		const resolver: IAgentResolver = {
			resolve: vi.fn(),
			resolveWithCache: vi.fn(async () => ({
				agentId: 42,
				chain: "eip155:1",
				ownerAddress: BOB_ADDRESS,
				agentAddress: BOB_ADDRESS,
				xmtpEndpoint: BOB_ADDRESS,
				endpoint: undefined,
				capabilities: ["message/send"],
				registrationFile: {
					type: "eip-8004-registration-v1",
					name: "Bob",
					description: "Test",
					services: [{ name: "xmtp", endpoint: BOB_ADDRESS }],
					trustedAgentProtocol: {
						version: "1.0",
						agentAddress: BOB_ADDRESS,
						capabilities: ["message/send"],
					},
				},
				resolvedAt: new Date().toISOString(),
			})),
		};

		const bobTransport = new XmtpTransport(
			{
				privateKey: BOB_PRIVATE_KEY,
				chain: "eip155:1",
				env: "dev",
				dbPath: join(testDir, "db-bob"),
				defaultResponseTimeoutMs: 45_000,
				agentResolver: resolver,
			},
			bobStore,
		);

		const carolTransport = new XmtpTransport(
			{
				privateKey: CAROL_PRIVATE_KEY,
				chain: "eip155:1",
				env: "dev",
				dbPath: join(testDir, "db-carol"),
				defaultResponseTimeoutMs: 45_000,
			},
			carolStore,
		);

		try {
			const callback = vi.fn(async (from: number, message: ProtocolMessage) => ({
				jsonrpc: "2.0",
				id: message.id,
				result: { accepted: true, from },
			}));
			bobTransport.onMessage(callback);

			await Promise.all([bobTransport.start(), carolTransport.start()]);

			const response = await carolTransport.send(
				999,
				{
					jsonrpc: "2.0",
					method: "connection/request",
					id: "xmtp-int-spoof-1",
					params: {
						from: { agentId: 42, chain: "eip155:1" },
						to: { agentId: 2, chain: "eip155:1" },
						proposedScope: ["message/send"],
						nonce: "spoof-1",
						timestamp: new Date().toISOString(),
					},
				},
				{
					peerAddress: BOB_ADDRESS,
					timeout: 45_000,
				},
			);

			expect(callback).not.toHaveBeenCalled();
			expect(response.error).toBeDefined();
			expect(response.error?.message).toContain("verification failed");
		} finally {
			await Promise.all([bobTransport.stop(), carolTransport.stop()]);
		}
	}, 120_000);
});
