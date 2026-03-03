import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestSigner } from "../../src/auth/signer.js";
import type { HttpRequestComponents } from "../../src/auth/types.js";
import { RequestVerifier } from "../../src/auth/verifier.js";
import { nowISO } from "../../src/common/time.js";
import { buildConnectionAccept, buildConnectionRequest } from "../../src/connection/handshake.js";
import { parseInviteUrl, verifyInvite } from "../../src/connection/invite-verifier.js";
import { generateInvite } from "../../src/connection/invite.js";
import { PendingInviteStore } from "../../src/connection/pending-invites.js";
import { FileTrustStore } from "../../src/trust/file-trust-store.js";
import type { Contact } from "../../src/trust/types.js";
import { ALICE, BOB } from "../fixtures/test-keys.js";

describe("Full connection flow", () => {
	let aliceTmpDir: string;
	let bobTmpDir: string;
	let aliceStore: FileTrustStore;
	let bobStore: FileTrustStore;

	beforeEach(async () => {
		aliceTmpDir = await mkdtemp(join(tmpdir(), "alice-store-"));
		bobTmpDir = await mkdtemp(join(tmpdir(), "bob-store-"));
		aliceStore = new FileTrustStore(aliceTmpDir);
		bobStore = new FileTrustStore(bobTmpDir);
	});

	afterEach(async () => {
		await rm(aliceTmpDir, { recursive: true, force: true });
		await rm(bobTmpDir, { recursive: true, force: true });
	});

	it("should complete the full invite -> connect -> store contacts flow", async () => {
		// Step 1: Alice generates an invite URL
		const { url, invite } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			privateKey: ALICE.privateKey,
		});

		// Alice tracks the pending invite
		const alicePendingInvites = new PendingInviteStore();
		alicePendingInvites.create(invite.nonce, invite.expires);

		// Step 2: Bob receives the URL, parses it
		const parsed = parseInviteUrl(url);
		expect(parsed.agentId).toBe(1);
		expect(parsed.chain).toBe("eip155:1");

		// Step 3: Bob verifies the invite signature
		const verifyResult = await verifyInvite(parsed);
		expect(verifyResult.valid).toBe(true);
		expect(verifyResult.signerAddress.toLowerCase()).toBe(ALICE.address.toLowerCase());

		// Step 4: Bob sends a connection/request (signed with ERC-8128)
		const connectionRequest = buildConnectionRequest({
			from: { agentId: 2, chain: "eip155:1" },
			to: { agentId: 1, chain: "eip155:1" },
			proposedScope: ["general-chat", "scheduling"],
			nonce: parsed.nonce,
			timestamp: nowISO(),
		});

		const bobSigner = new RequestSigner({
			privateKey: BOB.privateKey,
			chainId: 1,
			address: BOB.address,
		});

		const requestBody = JSON.stringify(connectionRequest);
		const requestComponents: HttpRequestComponents = {
			method: "POST",
			url: "https://alice-agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
		};

		const signedHeaders = await bobSigner.sign(requestComponents);

		// Step 5: Alice receives and verifies the signed request
		const verifier = new RequestVerifier();
		const authResult = await verifier.verify({
			...requestComponents,
			headers: { ...requestComponents.headers, ...signedHeaders },
		});

		expect(authResult.valid).toBe(true);
		expect(authResult.signerAddress!.toLowerCase()).toBe(BOB.address.toLowerCase());

		// Alice redeems the invite nonce (prevents reuse)
		expect(alicePendingInvites.redeem(parsed.nonce)).toBe(true);

		// Step 6: Alice accepts and sends connection/accept
		const connectionId = "conn-alice-bob-001";
		const connectionAccept = buildConnectionAccept({
			connectionId,
			from: { agentId: 1, chain: "eip155:1" },
			to: { agentId: 2, chain: "eip155:1" },
			acceptedScope: ["general-chat", "scheduling"],
			timestamp: nowISO(),
		});

		expect(connectionAccept.method).toBe("connection/accept");
		expect(connectionAccept.jsonrpc).toBe("2.0");

		// Step 7: Both agents store contacts in their trust stores
		const now = nowISO();

		const aliceContact: Contact = {
			connectionId,
			peerAgentId: 2,
			peerChain: "eip155:1",
			peerOwnerAddress: BOB.address,
			peerDisplayName: "Bob's Agent",
			peerEndpoint: "https://bob-agent.example.com/a2a",
			peerAgentAddress: BOB.address,
			permissions: { "general-chat": true, scheduling: true },
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		const bobContact: Contact = {
			connectionId,
			peerAgentId: 1,
			peerChain: "eip155:1",
			peerOwnerAddress: ALICE.address,
			peerDisplayName: "Alice's Agent",
			peerEndpoint: "https://alice-agent.example.com/a2a",
			peerAgentAddress: ALICE.address,
			permissions: { "general-chat": true, scheduling: true },
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		await aliceStore.addContact(aliceContact);
		await bobStore.addContact(bobContact);

		// Step 8: Verify trust stores have correct entries
		const aliceContacts = await aliceStore.getContacts();
		expect(aliceContacts).toHaveLength(1);
		expect(aliceContacts[0]!.peerAgentAddress.toLowerCase()).toBe(BOB.address.toLowerCase());
		expect(aliceContacts[0]!.permissions).toEqual({ "general-chat": true, scheduling: true });

		const bobContacts = await bobStore.getContacts();
		expect(bobContacts).toHaveLength(1);
		expect(bobContacts[0]!.peerAgentAddress.toLowerCase()).toBe(ALICE.address.toLowerCase());

		// Verify lookups work
		const foundByAddress = await aliceStore.findByAgentAddress(BOB.address);
		expect(foundByAddress).not.toBeNull();
		expect(foundByAddress!.connectionId).toBe(connectionId);

		const foundByAgentId = await bobStore.findByAgentId(1, "eip155:1");
		expect(foundByAgentId).not.toBeNull();
		expect(foundByAgentId!.peerDisplayName).toBe("Alice's Agent");
	});
});
