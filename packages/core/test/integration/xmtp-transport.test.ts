import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fsErrorCode } from "../../src/common/index.js";
import type { IAgentResolver } from "../../src/identity/resolver.js";
import { createEmptyPermissionState } from "../../src/permissions/types.js";
import { CONNECTION_REQUEST } from "../../src/protocol/index.js";
import { XmtpTransport } from "../../src/transport/xmtp.js";
import { FileTrustStore } from "../../src/trust/file-trust-store.js";
import type { Contact } from "../../src/trust/types.js";
import { createTestSigningProvider } from "../fixtures/test-keys.js";

const XMTP_ENABLED = process.env.XMTP_INTEGRATION === "true";
let ALICE_PRIVATE_KEY: `0x${string}`;
let BOB_PRIVATE_KEY: `0x${string}`;
let CAROL_PRIVATE_KEY: `0x${string}`;
let ALICE_ADDRESS: `0x${string}`;
let BOB_ADDRESS: `0x${string}`;

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
		permissions: createEmptyPermissionState(now),
		establishedAt: now,
		lastContactAt: now,
		status: "active",
	};
}

function dbEncryptionKeyForPrivateKey(privateKey: `0x${string}`): `0x${string}` {
	return keccak256(toHex(`xmtp-db-encryption:${privateKey}`));
}

describe.skipIf(!XMTP_ENABLED)("XmtpTransport integration", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "xmtp-transport-int-"));
		ALICE_PRIVATE_KEY = randomPrivateKey();
		BOB_PRIVATE_KEY = randomPrivateKey();
		CAROL_PRIVATE_KEY = randomPrivateKey();
		ALICE_ADDRESS = privateKeyToAccount(ALICE_PRIVATE_KEY).address;
		BOB_ADDRESS = privateKeyToAccount(BOB_PRIVATE_KEY).address;
	});

	afterEach(async () => {
		await removeDirWithRetry(testDir);
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
				signingProvider: createTestSigningProvider(ALICE_PRIVATE_KEY),
				chain: "eip155:1",
				dbPath: join(testDir, "db-alice"),
				dbEncryptionKey: dbEncryptionKeyForPrivateKey(ALICE_PRIVATE_KEY),
				defaultResponseTimeoutMs: 45_000,
			},
			aliceStore,
		);

		const bobTransport = new XmtpTransport(
			{
				signingProvider: createTestSigningProvider(BOB_PRIVATE_KEY),
				chain: "eip155:1",
				dbPath: join(testDir, "db-bob"),
				dbEncryptionKey: dbEncryptionKeyForPrivateKey(BOB_PRIVATE_KEY),
				defaultResponseTimeoutMs: 45_000,
			},
			bobStore,
		);

		try {
			bobTransport.setHandlers({
				onRequest: vi.fn(async () => ({
					status: "received",
				})),
			});

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

			expect(response.received).toBe(true);
			expect(response.status).toBe("received");
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
				signingProvider: createTestSigningProvider(BOB_PRIVATE_KEY),
				chain: "eip155:1",
				dbPath: join(testDir, "db-bob"),
				dbEncryptionKey: dbEncryptionKeyForPrivateKey(BOB_PRIVATE_KEY),
				defaultResponseTimeoutMs: 45_000,
				agentResolver: resolver,
			},
			bobStore,
		);

		const carolTransport = new XmtpTransport(
			{
				signingProvider: createTestSigningProvider(CAROL_PRIVATE_KEY),
				chain: "eip155:1",
				dbPath: join(testDir, "db-carol"),
				dbEncryptionKey: dbEncryptionKeyForPrivateKey(CAROL_PRIVATE_KEY),
				defaultResponseTimeoutMs: 45_000,
			},
			carolStore,
		);

		try {
			const callback = vi.fn(async () => ({ status: "queued" as const }));
			bobTransport.setHandlers({ onRequest: callback });

			await Promise.all([bobTransport.start(), carolTransport.start()]);

			await expect(
				carolTransport.send(
					999,
					{
						jsonrpc: "2.0",
						method: CONNECTION_REQUEST,
						id: "xmtp-int-spoof-1",
						params: {
							from: { agentId: 42, chain: "eip155:1" },
							to: { agentId: 2, chain: "eip155:1" },
							connectionId: "spoof-conn-1",
							nonce: "spoof-1",
							timestamp: new Date().toISOString(),
						},
					},
					{
						peerAddress: BOB_ADDRESS,
						timeout: 45_000,
					},
				),
			).rejects.toThrow(/verification failed|verification unavailable/i);
			expect(callback).not.toHaveBeenCalled();
		} finally {
			await Promise.all([bobTransport.stop(), carolTransport.stop()]);
		}
	}, 120_000);
});

function randomPrivateKey(): `0x${string}` {
	return `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
}

async function removeDirWithRetry(path: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error: unknown) {
			if (fsErrorCode(error) !== "ENOTEMPTY" || attempt === 4) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
}
