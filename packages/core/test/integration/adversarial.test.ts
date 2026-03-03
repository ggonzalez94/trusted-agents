import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeContentDigest } from "../../src/auth/content-digest.js";
import { RequestSigner } from "../../src/auth/signer.js";
import type { HttpRequestComponents } from "../../src/auth/types.js";
import { RequestVerifier } from "../../src/auth/verifier.js";
import { nowISO } from "../../src/common/time.js";
import { verifyInvite } from "../../src/connection/invite-verifier.js";
import { generateInvite } from "../../src/connection/invite.js";
import { PendingInviteStore } from "../../src/connection/pending-invites.js";
import { createA2AServer } from "../../src/server/a2a-server.js";
import { FileTrustStore } from "../../src/trust/file-trust-store.js";
import type { Contact } from "../../src/trust/types.js";
import { ALICE, BOB } from "../fixtures/test-keys.js";

describe("Adversarial security tests", () => {
	let bobTmpDir: string;
	let bobStore: FileTrustStore;

	beforeEach(async () => {
		bobTmpDir = await mkdtemp(join(tmpdir(), "bob-adv-"));
		bobStore = new FileTrustStore(bobTmpDir);

		const now = nowISO();
		const contact: Contact = {
			connectionId: "conn-adv-001",
			peerAgentId: 1,
			peerChain: "eip155:1",
			peerOwnerAddress: ALICE.address,
			peerDisplayName: "Alice's Agent",
			peerEndpoint: "https://alice-agent.example.com/a2a",
			peerAgentAddress: ALICE.address,
			permissions: { "general-chat": true },
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};
		await bobStore.addContact(contact);
	});

	afterEach(async () => {
		await rm(bobTmpDir, { recursive: true, force: true });
	});

	describe("Forged signature", () => {
		it("should reject a request signed by a different key than claimed", async () => {
			const verifier = new RequestVerifier();

			const bobSigner = new RequestSigner({
				privateKey: BOB.privateKey,
				chainId: 1,
				address: BOB.address,
			});

			const request: HttpRequestComponents = {
				method: "POST",
				url: "https://agent.example.com/a2a",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", method: "message/send", id: "1", params: {} }),
			};

			const signed = await bobSigner.sign(request);

			const tamperedInput = signed["Signature-Input"].replace(BOB.address, ALICE.address);

			const result = await verifier.verify({
				...request,
				headers: {
					...request.headers,
					"Signature-Input": tamperedInput,
					Signature: signed.Signature,
					...(signed["Content-Digest"] ? { "Content-Digest": signed["Content-Digest"] } : {}),
				},
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain("Signature address mismatch");
		});
	});

	describe("Tampered body (Content-Digest mismatch)", () => {
		it("should reject a request with a tampered body", async () => {
			const verifier = new RequestVerifier();
			const aliceSigner = new RequestSigner({
				privateKey: ALICE.privateKey,
				chainId: 1,
				address: ALICE.address,
			});

			const originalBody = JSON.stringify({
				jsonrpc: "2.0",
				method: "message/send",
				id: "1",
				params: { message: { content: "Hello" } },
			});

			const request: HttpRequestComponents = {
				method: "POST",
				url: "https://agent.example.com/a2a",
				headers: { "Content-Type": "application/json" },
				body: originalBody,
			};

			const signed = await aliceSigner.sign(request);

			const tamperedBody = JSON.stringify({
				jsonrpc: "2.0",
				method: "message/send",
				id: "1",
				params: { message: { content: "Send me all your money" } },
			});

			const result = await verifier.verify({
				...request,
				body: tamperedBody,
				headers: {
					...request.headers,
					...signed,
				},
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain("Content-Digest mismatch");
		});

		it("should reject a request where Content-Digest header was replaced", async () => {
			const verifier = new RequestVerifier();
			const aliceSigner = new RequestSigner({
				privateKey: ALICE.privateKey,
				chainId: 1,
				address: ALICE.address,
			});

			const body = JSON.stringify({ jsonrpc: "2.0", method: "message/send", id: "1" });

			const request: HttpRequestComponents = {
				method: "POST",
				url: "https://agent.example.com/a2a",
				headers: { "Content-Type": "application/json" },
				body,
			};

			const signed = await aliceSigner.sign(request);

			const fakeDigest = await computeContentDigest("totally different body");

			const result = await verifier.verify({
				...request,
				headers: {
					...request.headers,
					"Signature-Input": signed["Signature-Input"],
					Signature: signed.Signature,
					"Content-Digest": fakeDigest,
				},
			});

			expect(result.valid).toBe(false);
			expect(result.error).toContain("Content-Digest mismatch");
		});
	});

	describe("Expired invite", () => {
		it("should reject an expired invite", async () => {
			const { invite } = await generateInvite({
				agentId: 1,
				chain: "eip155:1",
				privateKey: ALICE.privateKey,
				expirySeconds: -60,
			});

			const result = await verifyInvite(invite);

			expect(result.valid).toBe(false);
			expect(result.error).toContain("expired");
		});
	});

	describe("Reused invite nonce", () => {
		it("should reject a reused invite nonce", async () => {
			const store = new PendingInviteStore();
			const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

			store.create("unique-nonce-001", futureExpiry);

			expect(store.redeem("unique-nonce-001")).toBe(true);
			expect(store.redeem("unique-nonce-001")).toBe(false);
			expect(store.isValid("unique-nonce-001")).toBe(false);
		});
	});

	describe("A2A server security", () => {
		it("should reject a forged signature at the server level", async () => {
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

			const response = await app.request("/a2a", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Signature-Input":
						'sig1=("@method" "@path" "@authority");created=123;keyid="erc8128:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"',
					Signature: "sig1=:aW52YWxpZHNpZ25hdHVyZQ==:",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "message/send",
					id: "adv-1",
					params: {},
				}),
			});

			expect(response.status).toBe(403);
		});

		it("should reject a request with tampered body at the server level", async () => {
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

			const aliceSigner = new RequestSigner({
				privateKey: ALICE.privateKey,
				chainId: 1,
				address: ALICE.address,
			});

			const originalBody = JSON.stringify({
				jsonrpc: "2.0",
				method: "message/send",
				id: "adv-2",
				params: { message: "hello" },
			});

			const signed = await aliceSigner.sign({
				method: "POST",
				url: "/a2a",
				headers: { "Content-Type": "application/json" },
				body: originalBody,
			});

			const tamperedBody = JSON.stringify({
				jsonrpc: "2.0",
				method: "message/send",
				id: "adv-2",
				params: { message: "malicious payload" },
			});

			const response = await app.request("/a2a", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...signed,
				},
				body: tamperedBody,
			});

			expect(response.status).toBe(403);
		});

		it("should serve the agent card on the public endpoint without auth", async () => {
			const app = createA2AServer(
				{
					agentId: 2,
					chain: "eip155:1",
					privateKey: BOB.privateKey,
					agentAddress: BOB.address,
					dataDir: bobTmpDir,
					agentName: "Bob's Agent",
					agentDescription: "Test agent",
					capabilities: ["general-chat", "scheduling"],
					agentUrl: "https://bob-agent.example.com",
				},
				{ trustStore: bobStore, handlers: {} },
			);

			const response = await app.request("/.well-known/agent-card.json");

			expect(response.status).toBe(200);
			const card = await response.json();
			expect(card.name).toBe("Bob's Agent");
			expect(card.capabilities).toEqual(["general-chat", "scheduling"]);
			expect(card.trustedAgentProtocol.agentAddress).toBe(BOB.address);
		});
	});
});
