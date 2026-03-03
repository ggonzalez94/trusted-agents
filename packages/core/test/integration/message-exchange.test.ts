import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestSigner } from "../../src/auth/signer.js";
import type { HttpRequestComponents } from "../../src/auth/types.js";
import { RequestVerifier } from "../../src/auth/verifier.js";
import { nowISO } from "../../src/common/time.js";
import { FileConversationLogger } from "../../src/conversation/logger.js";
import type { ConversationMessage } from "../../src/conversation/types.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { createJsonRpcRequest } from "../../src/protocol/messages.js";
import { MESSAGE_SEND } from "../../src/protocol/methods.js";
import { FileTrustStore } from "../../src/trust/file-trust-store.js";
import type { Contact } from "../../src/trust/types.js";
import { ALICE, BOB } from "../fixtures/test-keys.js";

describe("Message exchange after connection", () => {
	let aliceTmpDir: string;
	let bobTmpDir: string;
	let aliceStore: FileTrustStore;
	let bobStore: FileTrustStore;
	let aliceLogger: FileConversationLogger;
	let bobLogger: FileConversationLogger;
	const connectionId = "conn-msg-exchange-001";
	const conversationId = "conv-msg-exchange-001";

	beforeEach(async () => {
		aliceTmpDir = await mkdtemp(join(tmpdir(), "alice-msg-"));
		bobTmpDir = await mkdtemp(join(tmpdir(), "bob-msg-"));
		aliceStore = new FileTrustStore(aliceTmpDir);
		bobStore = new FileTrustStore(bobTmpDir);
		aliceLogger = new FileConversationLogger(aliceTmpDir);
		bobLogger = new FileConversationLogger(bobTmpDir);

		// Pre-establish connection between Alice and Bob
		const now = nowISO();
		const aliceContact: Contact = {
			connectionId,
			peerAgentId: 2,
			peerChain: "eip155:1",
			peerOwnerAddress: BOB.address,
			peerDisplayName: "Bob's Agent",
			peerEndpoint: "https://bob-agent.example.com/a2a",
			peerAgentAddress: BOB.address,
			permissions: { "general-chat": true, scheduling: true, purchases: false },
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
			permissions: { "general-chat": true, scheduling: true, purchases: false },
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		await aliceStore.addContact(aliceContact);
		await bobStore.addContact(bobContact);
	});

	afterEach(async () => {
		await rm(aliceTmpDir, { recursive: true, force: true });
		await rm(bobTmpDir, { recursive: true, force: true });
	});

	it("should complete a full message exchange with auth, permissions, and logging", async () => {
		const aliceSigner = new RequestSigner({
			privateKey: ALICE.privateKey,
			chainId: 1,
			address: ALICE.address,
		});
		const verifier = new RequestVerifier();
		const permEngine = new PermissionEngine();

		// Step 1: Alice sends a message/send to Bob (signed, with scope)
		const messageRequest = createJsonRpcRequest(MESSAGE_SEND, {
			message: {
				messageId: "msg-001",
				role: "user",
				parts: [{ kind: "text", text: "Hey Bob, can we schedule a meeting?" }],
				metadata: {
					trustedAgent: {
						connectionId,
						conversationId,
						scope: "general-chat",
						requiresHumanApproval: false,
					},
				},
			},
		});

		const requestBody = JSON.stringify(messageRequest);
		const requestComponents: HttpRequestComponents = {
			method: "POST",
			url: "https://bob-agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
		};

		const signedHeaders = await aliceSigner.sign(requestComponents);

		// Step 2: Bob verifies the auth
		const authResult = await verifier.verify({
			...requestComponents,
			headers: { ...requestComponents.headers, ...signedHeaders },
		});

		expect(authResult.valid).toBe(true);
		expect(authResult.signerAddress!.toLowerCase()).toBe(ALICE.address.toLowerCase());

		// Step 3: Bob checks permissions
		const bobContactForAlice = await bobStore.findByAgentAddress(authResult.signerAddress!);
		expect(bobContactForAlice).not.toBeNull();

		const permResult = permEngine.check(bobContactForAlice!, "general-chat");
		expect(permResult.allowed).toBe(true);

		// Step 4: Bob logs the incoming message
		const incomingMsg: ConversationMessage = {
			timestamp: nowISO(),
			direction: "incoming",
			scope: "general-chat",
			content: "Hey Bob, can we schedule a meeting?",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};
		await bobLogger.logMessage(conversationId, incomingMsg);

		// Alice also logs the outgoing message
		const outgoingMsgAlice: ConversationMessage = {
			timestamp: incomingMsg.timestamp,
			direction: "outgoing",
			scope: "general-chat",
			content: "Hey Bob, can we schedule a meeting?",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};
		await aliceLogger.logMessage(conversationId, outgoingMsgAlice);

		// Step 5: Bob responds (signed)
		const bobSigner = new RequestSigner({
			privateKey: BOB.privateKey,
			chainId: 1,
			address: BOB.address,
		});

		const responseRequest = createJsonRpcRequest(MESSAGE_SEND, {
			message: {
				messageId: "msg-002",
				role: "agent",
				parts: [{ kind: "text", text: "Sure! How about Thursday at 2pm?" }],
				metadata: {
					trustedAgent: {
						connectionId,
						conversationId,
						scope: "general-chat",
						requiresHumanApproval: false,
					},
				},
			},
		});

		const responseBody = JSON.stringify(responseRequest);
		const responseComponents: HttpRequestComponents = {
			method: "POST",
			url: "https://alice-agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: responseBody,
		};

		const bobSignedHeaders = await bobSigner.sign(responseComponents);

		// Alice verifies Bob's response
		const bobAuthResult = await verifier.verify({
			...responseComponents,
			headers: { ...responseComponents.headers, ...bobSignedHeaders },
		});

		expect(bobAuthResult.valid).toBe(true);
		expect(bobAuthResult.signerAddress!.toLowerCase()).toBe(BOB.address.toLowerCase());

		// Step 6: Both log the second message
		const incomingMsgAlice: ConversationMessage = {
			timestamp: nowISO(),
			direction: "incoming",
			scope: "general-chat",
			content: "Sure! How about Thursday at 2pm?",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};
		await aliceLogger.logMessage(conversationId, incomingMsgAlice);

		const outgoingMsgBob: ConversationMessage = {
			timestamp: incomingMsgAlice.timestamp,
			direction: "outgoing",
			scope: "general-chat",
			content: "Sure! How about Thursday at 2pm?",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};
		await bobLogger.logMessage(conversationId, outgoingMsgBob);

		// Step 7: Verify conversation logs
		const aliceConv = await aliceLogger.getConversation(conversationId);
		expect(aliceConv).not.toBeNull();
		expect(aliceConv!.messages).toHaveLength(2);
		expect(aliceConv!.messages[0]!.direction).toBe("outgoing");
		expect(aliceConv!.messages[1]!.direction).toBe("incoming");

		const bobConv = await bobLogger.getConversation(conversationId);
		expect(bobConv).not.toBeNull();
		expect(bobConv!.messages).toHaveLength(2);
		expect(bobConv!.messages[0]!.direction).toBe("incoming");
		expect(bobConv!.messages[1]!.direction).toBe("outgoing");
	});
});
