import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestSigner } from "../../src/auth/signer.js";
import { nowISO } from "../../src/common/time.js";
import { FilePendingInviteStore } from "../../src/connection/pending-invites.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { createA2AServer } from "../../src/server/a2a-server.js";
import { FileTrustStore } from "../../src/trust/file-trust-store.js";
import type { Contact } from "../../src/trust/types.js";
import { ALICE, BOB } from "../fixtures/test-keys.js";

describe("Permission denial", () => {
	let bobTmpDir: string;
	let bobStore: FileTrustStore;
	const connectionId = "conn-perm-test-001";

	beforeEach(async () => {
		bobTmpDir = await mkdtemp(join(tmpdir(), "bob-perm-"));
		bobStore = new FileTrustStore(bobTmpDir);

		const now = nowISO();
		const bobContact: Contact = {
			connectionId,
			peerAgentId: 1,
			peerChain: "eip155:1",
			peerOwnerAddress: ALICE.address,
			peerDisplayName: "Alice's Agent",
			peerEndpoint: "https://alice-agent.example.com/a2a",
			peerAgentAddress: ALICE.address,
			permissions: { "general-chat": true, purchases: false },
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		await bobStore.addContact(bobContact);
	});

	afterEach(async () => {
		await rm(bobTmpDir, { recursive: true, force: true });
	});

	it("should deny a message with a scope not in permissions", async () => {
		const permEngine = new PermissionEngine();
		const contact = await bobStore.findByAgentAddress(ALICE.address);
		expect(contact).not.toBeNull();

		const result = permEngine.check(contact!, "scheduling");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("Unknown scope");
	});

	it("should deny a message with an explicitly denied scope", async () => {
		const permEngine = new PermissionEngine();
		const contact = await bobStore.findByAgentAddress(ALICE.address);
		expect(contact).not.toBeNull();

		const result = permEngine.check(contact!, "purchases");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("denied");
	});

	it("should deny an unsigned request to the A2A server", async () => {
		const app = createA2AServer(
			{
				agentId: 2,
				chain: "eip155:1",
				privateKey: BOB.privateKey,
				agentAddress: BOB.address,
				dataDir: bobTmpDir,
				agentName: "Bob's Agent",
				agentDescription: "Test agent",
				capabilities: ["general-chat"],
				agentUrl: "https://bob-agent.example.com",
			},
			{ trustStore: bobStore, handlers: {} },
		);

		const response = await app.request("/a2a", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "message/send",
				id: "test-1",
				params: {},
			}),
		});

		expect(response.status).toBe(403);
		const body = await response.json();
		expect(body.error?.message).toBe("Forbidden");
	});

	it("should deny a request from an unknown peer (not in trust store)", async () => {
		const app = createA2AServer(
			{
				agentId: 2,
				chain: "eip155:1",
				privateKey: BOB.privateKey,
				agentAddress: BOB.address,
				dataDir: bobTmpDir,
				agentName: "Bob's Agent",
				agentDescription: "Test agent",
				capabilities: ["general-chat"],
				agentUrl: "https://bob-agent.example.com",
			},
			{
				trustStore: bobStore,
				handlers: {
					"message/send": async () => ({ ok: true }),
				},
			},
		);

		const unknownSigner = new RequestSigner({
			privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
			chainId: 1,
			address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
		});

		const requestBody = JSON.stringify({
			jsonrpc: "2.0",
			method: "message/send",
			id: "test-2",
			params: {},
		});

		const signed = await unknownSigner.sign({
			method: "POST",
			url: "/a2a",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
		});

		const response = await app.request("/a2a", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...signed,
			},
			body: requestBody,
		});

		expect(response.status).toBe(403);
	});

	it("should allow bootstrap methods from unknown peers", async () => {
		const pendingInvites = new FilePendingInviteStore(bobTmpDir);
		const bootstrapNonce = "test-nonce";
		await pendingInvites.create(bootstrapNonce, Math.floor(Date.now() / 1000) + 3600);

		const app = createA2AServer(
			{
				agentId: 2,
				chain: "eip155:1",
				privateKey: BOB.privateKey,
				agentAddress: BOB.address,
				dataDir: bobTmpDir,
				agentName: "Bob's Agent",
				agentDescription: "Test agent",
				capabilities: ["general-chat"],
				agentUrl: "https://bob-agent.example.com",
			},
			{
				trustStore: bobStore,
				pendingInviteStore: pendingInvites,
				handlers: {
					"connection/request": async () => ({ accepted: true }),
				},
			},
		);

		const unknownSigner = new RequestSigner({
			privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
			chainId: 1,
			address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
		});

		const requestBody = JSON.stringify({
			jsonrpc: "2.0",
			method: "connection/request",
			id: "test-3",
			params: {
				from: { agentId: 3, chain: "eip155:1" },
				to: { agentId: 2, chain: "eip155:1" },
				proposedScope: ["general-chat"],
				nonce: bootstrapNonce,
				timestamp: nowISO(),
			},
		});

		const signed = await unknownSigner.sign({
			method: "POST",
			url: "/a2a",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
		});

		const response = await app.request("/a2a", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...signed,
			},
			body: requestBody,
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.result).toEqual({ accepted: true });
	});

	it("should not leak information in error responses", async () => {
		const app = createA2AServer(
			{
				agentId: 2,
				chain: "eip155:1",
				privateKey: BOB.privateKey,
				agentAddress: BOB.address,
				dataDir: bobTmpDir,
				agentName: "Bob's Agent",
				agentDescription: "Test agent",
				capabilities: ["general-chat"],
				agentUrl: "https://bob-agent.example.com",
			},
			{ trustStore: bobStore, handlers: {} },
		);

		const response = await app.request("/a2a", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "message/send",
				id: "test-4",
				params: {},
			}),
		});

		const body = await response.json();

		expect(body.error?.message).toBe("Forbidden");
		expect(JSON.stringify(body)).not.toContain("stack");
		expect(JSON.stringify(body)).not.toContain("privateKey");
		expect(JSON.stringify(body)).not.toContain("password");
	});
});
