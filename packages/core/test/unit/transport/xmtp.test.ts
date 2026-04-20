import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@xmtp/node-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionError } from "../../../src/common/errors.js";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import type {
	InboundRequestEnvelope,
	ProtocolMessage,
	TransportAck,
	TransportReceipt,
} from "../../../src/transport/interface.js";
import type { XmtpTransportConfig } from "../../../src/transport/xmtp-types.js";
import { XmtpTransport } from "../../../src/transport/xmtp.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE, ALICE_SIGNING_PROVIDER, BOB } from "../../fixtures/test-keys.js";
import { useTempDir } from "../../helpers/temp-dir.js";

// --- Test internals access ---
// biome-ignore lint/suspicious/noExplicitAny: test helper to access private members
type Internals = Record<string, any>;
function internals(t: XmtpTransport): Internals {
	return t as unknown as Internals;
}

// --- Mock XMTP Client ---

interface MockMessage {
	senderInboxId: string;
	content: unknown;
	conversationId?: string;
	id?: string;
	sentAtNs?: bigint;
}

interface StoredMockMessage {
	senderInboxId: string;
	content: unknown;
	conversationId: string;
	id: string;
	sentAtNs: bigint;
	sentAt: Date;
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createMockConversation() {
	const sentMessages: string[] = [];
	return {
		sendText: vi.fn(async (text: string) => {
			sentMessages.push(text);
		}),
		sentMessages,
	};
}

function createMockClient(opts?: { inboxId?: string }) {
	const clientInboxId = opts?.inboxId ?? "self-inbox-id";
	const messageListeners: Array<(msg: MockMessage) => void> = [];
	const mockConversation = createMockConversation();
	const inboxIdentifiers = new Map<string, Array<{ identifier: string; identifierKind: number }>>();
	const streamOptions: unknown[] = [];
	const conversationMessages = new Map<string, StoredMockMessage[]>();

	const normalizeMessage = (message: MockMessage): StoredMockMessage => {
		const conversationId = message.conversationId ?? "dm-default";
		const sentAtNs = message.sentAtNs ?? BigInt(Date.now()) * 1_000_000n;
		return {
			senderInboxId: message.senderInboxId,
			content: message.content,
			conversationId,
			id: message.id ?? `${conversationId}-${String(sentAtNs)}`,
			sentAtNs,
			sentAt: new Date(Number(sentAtNs / 1_000_000n)),
		};
	};

	const readConversationMessages = (
		conversationId: string,
		options?: { sentAfterNs?: bigint; direction?: number },
	) => {
		const messages = [...(conversationMessages.get(conversationId) ?? [])].filter((message) => {
			if (options?.sentAfterNs !== undefined && message.sentAtNs <= options.sentAfterNs) {
				return false;
			}
			return true;
		});
		messages.sort((left, right) =>
			options?.direction === 1
				? Number(right.sentAtNs - left.sentAtNs)
				: Number(left.sentAtNs - right.sentAtNs),
		);
		return messages;
	};

	const createDmRecord = (conversationId: string) => ({
		id: conversationId,
		messages: vi.fn(async (options?: { sentAfterNs?: bigint; direction?: number }) =>
			readConversationMessages(conversationId, options),
		),
		lastMessage: vi.fn(async () => {
			const messages = conversationMessages.get(conversationId) ?? [];
			return messages[messages.length - 1];
		}),
	});

	const client = {
		inboxId: clientInboxId,
		register: vi.fn(async () => {}),
		revokeAllOtherInstallations: vi.fn(async () => {}),
		conversations: {
			streamAllDmMessages: vi.fn(async (options?: unknown) => {
				streamOptions.push(options ?? null);
				const queue: MockMessage[] = [];
				let resolver: ((value: IteratorResult<MockMessage>) => void) | null = null;
				let done = false;

				const pushMessage = (msg: MockMessage) => {
					if (resolver) {
						const r = resolver;
						resolver = null;
						r({ value: msg, done: false });
					} else {
						queue.push(msg);
					}
				};

				messageListeners.push(pushMessage);

				return {
					[Symbol.asyncIterator]() {
						return this;
					},
					async next(): Promise<IteratorResult<MockMessage>> {
						if (done) return { value: undefined, done: true };
						if (queue.length > 0) {
							return { value: queue.shift()!, done: false };
						}
						return new Promise((resolve) => {
							resolver = resolve;
						});
					},
					async return() {
						done = true;
						if (resolver) {
							resolver({ value: undefined, done: true });
						}
						return { value: undefined, done: true as const };
					},
				};
			}),
			syncAll: vi.fn(async () => ({ numEligible: 0, numSynced: 0 })),
			listDms: vi.fn(() =>
				[...conversationMessages.keys()]
					.sort()
					.map((conversationId) => createDmRecord(conversationId)),
			),
			createDm: vi.fn(async (_inboxId: string) => mockConversation),
		},
		fetchInboxIdByIdentifier: vi.fn(async (identifier: { identifier: string }) => {
			return `inbox-for-${identifier.identifier.toLowerCase()}`;
		}),
		canMessage: vi.fn(async (identifiers: Array<{ identifier: string }>) => {
			const result = new Map<string, boolean>();
			for (const id of identifiers) {
				result.set(id.identifier, true);
			}
			return result;
		}),
		preferences: {
			fetchInboxStates: vi.fn(async (inboxIds: string[]) =>
				inboxIds.map((inboxId) => ({
					inboxId,
					identifiers: inboxIdentifiers.get(inboxId) ?? [],
				})),
			),
		},
	};

	return {
		client,
		mockConversation,
		setInboxIdentifiers: (
			inboxId: string,
			identifiers: Array<{ identifier: string; identifierKind: number }>,
		) => {
			inboxIdentifiers.set(inboxId, identifiers);
		},
		setConversationMessages: (conversationId: string, messages: MockMessage[]) => {
			conversationMessages.set(
				conversationId,
				messages
					.map(normalizeMessage)
					.sort((left, right) => Number(left.sentAtNs - right.sentAtNs)),
			);
		},
		pushMessage: (msg: MockMessage) => {
			for (const listener of messageListeners) {
				listener(msg);
			}
		},
		streamOptions,
	};
}

function createMockTrustStore(contacts: Contact[] = []): ITrustStore {
	return {
		getContacts: vi.fn(async () => contacts),
		getContact: vi.fn(async (id: string) => contacts.find((c) => c.connectionId === id) ?? null),
		findByAgentAddress: vi.fn(
			async (address: `0x${string}`) =>
				contacts.find((c) => c.peerAgentAddress.toLowerCase() === address.toLowerCase()) ?? null,
		),
		findByAgentId: vi.fn(
			async (agentId: number, chain: string) =>
				contacts.find((c) => c.peerAgentId === agentId && c.peerChain === chain) ?? null,
		),
		addContact: vi.fn(async () => {}),
		updateContact: vi.fn(async () => {}),
		removeContact: vi.fn(async () => {}),
		touchContact: vi.fn(async () => {}),
	};
}

const TEST_CONFIG: XmtpTransportConfig = {
	signingProvider: ALICE_SIGNING_PROVIDER,
	chain: "eip155:1",
	defaultResponseTimeoutMs: 5_000,
};

const BOB_CONTACT: Contact = {
	connectionId: "conn-bob",
	peerAgentId: 42,
	peerChain: "eip155:1",
	peerOwnerAddress: BOB.address,
	peerDisplayName: "Bob's Agent",
	peerAgentAddress: BOB.address,
	permissions: createEmptyPermissionState(),
	establishedAt: new Date().toISOString(),
	lastContactAt: new Date().toISOString(),
	status: "active",
};

const BOB_CONTACT_LEGACY: Contact = {
	...BOB_CONTACT,
	connectionId: "conn-bob-legacy",
	peerAgentId: 7,
};

const BOB_INBOX_ID = `inbox-for-${BOB.address.toLowerCase()}`;

function makeDmMessage(
	id: string,
	opts?: { sentAtNs?: bigint; conversationId?: string; rpcId?: string },
): StoredMockMessage & { content: string } {
	return {
		id,
		sentAtNs: opts?.sentAtNs ?? 1_000n,
		sentAt: new Date(Number((opts?.sentAtNs ?? 1_000n) / 1_000_000n)),
		senderInboxId: BOB_INBOX_ID,
		conversationId: opts?.conversationId ?? "dm-1",
		content: JSON.stringify({
			jsonrpc: "2.0",
			method: "message/send",
			id: opts?.rpcId ?? id,
		}),
	};
}

function createBobResolver(opts?: { agentId?: number; capabilities?: string[] }) {
	const agentId = opts?.agentId ?? 99;
	const capabilities = opts?.capabilities ?? ["message/send"];
	return {
		resolve: vi.fn(),
		resolveWithCache: vi.fn(async () => ({
			agentId,
			chain: "eip155:1",
			ownerAddress: BOB.address,
			agentAddress: BOB.address,
			xmtpEndpoint: BOB.address,
			endpoint: undefined,
			capabilities,
			registrationFile: {
				type: "eip-8004-registration-v1" as const,
				name: agentId === BOB_CONTACT.peerAgentId ? BOB_CONTACT.peerDisplayName : "Bob",
				description: "Test",
				services: [{ name: "xmtp", endpoint: BOB.address }],
				trustedAgentProtocol: {
					version: "1.0",
					agentAddress: BOB.address,
					capabilities,
				},
			},
			resolvedAt: new Date().toISOString(),
		})),
	};
}

function createAmbiguousTrustStore(overrides?: Partial<ITrustStore>): ITrustStore {
	return {
		getContacts: vi.fn(async () => [BOB_CONTACT, BOB_CONTACT_LEGACY]),
		getContact: vi.fn(async () => null),
		findByAgentAddress: vi
			.fn<ITrustStore["findByAgentAddress"]>()
			.mockRejectedValue(
				new ConnectionError(`Multiple active contacts match address ${BOB.address}`),
			),
		findByAgentId: vi.fn(async () => null),
		addContact: vi.fn(async () => {}),
		updateContact: vi.fn(async () => {}),
		removeContact: vi.fn(async () => {}),
		touchContact: vi.fn(async () => {}),
		...overrides,
	};
}

describe("XmtpTransport", () => {
	const dir = useTempDir("xmtp-transport-unit");
	let transport: XmtpTransport;
	let trustStore: ITrustStore;
	let mockSetup: ReturnType<typeof createMockClient>;

	beforeEach(async () => {
		trustStore = createMockTrustStore([BOB_CONTACT]);
		transport = new XmtpTransport(
			{
				...TEST_CONFIG,
				dbPath: join(dir.path, "xmtp"),
			},
			trustStore,
		);
		mockSetup = createMockClient();
	});

	afterEach(async () => {
		try {
			await transport.stop();
		} catch {
			// already stopped
		}
	});

	function injectMockClient(t: XmtpTransport = transport) {
		internals(t).client = mockSetup.client;
		internals(t).running = true;
	}

	describe("lifecycle", () => {
		it("should throw on send before start", async () => {
			const message: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "test/method",
				id: "msg-1",
			};
			await expect(transport.send(42, message)).rejects.toThrow("not started");
		});

		it("should return false for isReachable before start", async () => {
			expect(await transport.isReachable(42)).toBe(false);
		});

		it("clears the client creation timeout after start succeeds", async () => {
			vi.useFakeTimers();
			const createSpy = vi
				.spyOn(Client, "create")
				.mockResolvedValue(
					mockSetup.client as unknown as Awaited<ReturnType<typeof Client.create>>,
				);
			const startedTransport = new XmtpTransport(
				{
					...TEST_CONFIG,
					dbPath: join(dir.path, "xmtp-start"),
					dbEncryptionKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
				},
				trustStore,
			);

			try {
				await startedTransport.start();

				expect(createSpy).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await startedTransport.stop();
				createSpy.mockRestore();
				vi.useRealTimers();
			}
		});
	});

	describe("send", () => {
		it("should serialize message as JSON and send via DM", async () => {
			injectMockClient();

			const message: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "test/method",
				id: "msg-1",
			};

			// Simulate a response arriving after a short delay
			setTimeout(() => {
				const pending = internals(transport).pendingRequests.get("msg-1");
				if (pending) {
					clearTimeout(pending.timer);
					internals(transport).pendingRequests.delete("msg-1");
					pending.resolve({
						received: true,
						requestId: "msg-1",
						status: "received",
						receivedAt: new Date().toISOString(),
					});
				}
			}, 50);

			const response = await transport.send(42, message);

			expect(response.requestId).toBe("msg-1");
			expect(response.status).toBe("received");
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalledWith(JSON.stringify(message));
		});

		it("should throw on timeout when no response arrives", async () => {
			injectMockClient();

			const config = { ...TEST_CONFIG, defaultResponseTimeoutMs: 100 };
			const shortTransport = new XmtpTransport(config, trustStore);
			injectMockClient(shortTransport);

			const message: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "test/method",
				id: "timeout-msg",
			};

			await expect(shortTransport.send(42, message)).rejects.toThrow("timeout");
		});

		it("should send using peerAddress option without trust store lookup", async () => {
			injectMockClient();

			const message: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "direct-msg",
			};

			// Simulate a response arriving after a short delay
			setTimeout(() => {
				const pending = internals(transport).pendingRequests.get("direct-msg");
				if (pending) {
					clearTimeout(pending.timer);
					internals(transport).pendingRequests.delete("direct-msg");
					pending.resolve({
						received: true,
						requestId: "direct-msg",
						status: "queued",
						receivedAt: new Date().toISOString(),
					});
				}
			}, 50);

			const response = await transport.send(999, message, {
				peerAddress: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
			});

			expect(response.status).toBe("queued");
			// Should NOT have called findByAgentId since peerAddress was provided
			expect(trustStore.findByAgentId).not.toHaveBeenCalled();
		});

		it("should throw when contact not found", async () => {
			injectMockClient();

			const message: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "test/method",
				id: "msg-1",
			};

			await expect(transport.send(999, message)).rejects.toThrow("No contact found");
		});
	});

	describe("incoming message processing", () => {
		it.each<[string, string | null, unknown]>([
			["self-messages", null, JSON.stringify({ jsonrpc: "2.0", method: "test/method", id: "1" })],
			["non-string content", "other-inbox", 12345],
			["non-JSON content", "other-inbox", "not json at all"],
			["non-JSON-RPC messages", "other-inbox", JSON.stringify({ hello: "world" })],
		])("should skip %s", async (_desc, senderInboxId, content) => {
			injectMockClient();
			const callback = vi.fn();
			transport.setHandlers({ onRequest: callback });
			await internals(transport).processMessage({
				senderInboxId: senderInboxId ?? mockSetup.client.inboxId,
				content,
			});
			expect(callback).not.toHaveBeenCalled();
		});

		it("should resolve pending request when response arrives", async () => {
			injectMockClient();

			const responseData = {
				jsonrpc: "2.0",
				id: "req-123",
				result: {
					received: true,
					requestId: "req-123",
					status: "received",
					receivedAt: "2025-01-01T00:00:00.000Z",
				},
			};

			// Set up a pending request
			let resolved: TransportReceipt | undefined;
			const timer = setTimeout(() => {}, 30000);
			internals(transport).pendingRequests.set("req-123", {
				resolve: (r: TransportReceipt) => {
					resolved = r;
				},
				reject: () => {},
				timer,
				senderInboxId: "other-inbox",
			});

			await internals(transport).processMessage({
				senderInboxId: "other-inbox",
				content: JSON.stringify(responseData),
			});

			expect(resolved).toBeDefined();
			expect(resolved!.status).toBe("received");
			expect(internals(transport).pendingRequests.has("req-123")).toBe(false);
		});

		it("should ignore receipts from the wrong inbox", async () => {
			injectMockClient();

			const responseData = {
				jsonrpc: "2.0",
				id: "req-foreign",
				result: {
					received: true,
					requestId: "req-foreign",
					status: "received",
					receivedAt: "2025-01-01T00:00:00.000Z",
				},
			};

			let resolved: TransportReceipt | undefined;
			const timer = setTimeout(() => {}, 30000);
			internals(transport).pendingRequests.set("req-foreign", {
				resolve: (receipt: TransportReceipt) => {
					resolved = receipt;
				},
				reject: () => {},
				timer,
				senderInboxId: "expected-inbox",
			});

			await internals(transport).processMessage({
				senderInboxId: "wrong-inbox",
				content: JSON.stringify(responseData),
			});

			expect(resolved).toBeUndefined();
			expect(internals(transport).pendingRequests.has("req-foreign")).toBe(true);

			await internals(transport).processMessage({
				senderInboxId: "expected-inbox",
				content: JSON.stringify(responseData),
			});

			expect(resolved).toEqual(
				expect.objectContaining({
					requestId: "req-foreign",
					status: "received",
				}),
			);
			expect(internals(transport).pendingRequests.has("req-foreign")).toBe(false);
		});

		it("should route incoming requests to message callback for known contacts", async () => {
			injectMockClient();

			// Register BOB's inbox -> address mapping
			internals(transport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transport.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "req-456",
			};

			await internals(transport).processMessage({
				senderInboxId: BOB_INBOX_ID,
				content: JSON.stringify(request),
			});

			expect(callback).toHaveBeenCalledWith({
				from: 42,
				senderInboxId: BOB_INBOX_ID,
				message: request,
			});
		});

		it("should ignore duplicate inbound requests with the same sender and request id", async () => {
			injectMockClient();

			internals(transport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transport.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "req-duplicate",
			};

			await internals(transport).processMessage({
				senderInboxId: BOB_INBOX_ID,
				content: JSON.stringify(request),
			});
			await internals(transport).processMessage({
				senderInboxId: BOB_INBOX_ID,
				content: JSON.stringify(request),
			});

			expect(callback).toHaveBeenCalledTimes(1);
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalledTimes(1);
		});

		it("should allow a retry after transient request handling failure", async () => {
			const failingTrustStore = createMockTrustStore([BOB_CONTACT]);
			const retryTransport = new XmtpTransport(TEST_CONFIG, failingTrustStore);
			injectMockClient(retryTransport);
			internals(retryTransport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			failingTrustStore.findByAgentAddress = vi
				.fn<ITrustStore["findByAgentAddress"]>()
				.mockRejectedValueOnce(new Error("temporary lookup failure"))
				.mockResolvedValue(BOB_CONTACT);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			retryTransport.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "req-retryable",
			};

			await expect(
				internals(retryTransport).processMessage({
					senderInboxId: BOB_INBOX_ID,
					content: JSON.stringify(request),
				}),
			).rejects.toThrow("temporary lookup failure");

			await expect(
				internals(retryTransport).processMessage({
					senderInboxId: BOB_INBOX_ID,
					content: JSON.stringify(request),
				}),
			).resolves.toBe(true);

			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("should reject non-bootstrap requests from unknown senders", async () => {
			injectMockClient();

			const callback = vi.fn(
				async (): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transport.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "msg-unknown",
			};

			await internals(transport).processMessage({
				senderInboxId: "unknown-inbox",
				content: JSON.stringify(request),
			});

			expect(callback).not.toHaveBeenCalled();
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalled();
		});

		it("should verify bootstrap connection/request sender using resolver + inbox state", async () => {
			const bootstrapTrustStore = createMockTrustStore([]);
			const resolver = createBobResolver();
			const transportWithResolver = new XmtpTransport(
				{
					...TEST_CONFIG,
					agentResolver: resolver,
				},
				bootstrapTrustStore,
			);
			injectMockClient(transportWithResolver);

			mockSetup.setInboxIdentifiers("unknown-inbox", [
				{ identifier: BOB.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "queued",
				}),
			);
			transportWithResolver.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "conn-1",
				params: {
					from: { agentId: 99, chain: "eip155:1" },
					to: { agentId: 1, chain: "eip155:1" },
					connectionId: "conn-1",
					nonce: "abc",
					timestamp: new Date().toISOString(),
				},
			};

			await internals(transportWithResolver).processMessage({
				senderInboxId: "unknown-inbox",
				content: JSON.stringify(request),
			});

			expect(callback).toHaveBeenCalledWith({
				from: 99,
				senderInboxId: "unknown-inbox",
				message: request,
			});
		});

		it("should bootstrap-verify connection/request senders when address lookup is ambiguous", async () => {
			const bootstrapTrustStore = createAmbiguousTrustStore();
			const resolver = createBobResolver();
			const transportWithResolver = new XmtpTransport(
				{
					...TEST_CONFIG,
					agentResolver: resolver,
				},
				bootstrapTrustStore,
			);
			injectMockClient(transportWithResolver);

			mockSetup.setInboxIdentifiers("ambiguous-bootstrap-inbox", [
				{ identifier: BOB.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "queued",
				}),
			);
			transportWithResolver.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "conn-ambiguous-bootstrap",
				params: {
					from: { agentId: 99, chain: "eip155:1" },
					timestamp: new Date().toISOString(),
					invite: {
						agentId: 1,
						chain: "eip155:1",
						expires: Math.floor(Date.now() / 1000) + 300,
						signature: "0xdeadbeef",
					},
				},
			};

			await expect(
				internals(transportWithResolver).processMessage({
					senderInboxId: "ambiguous-bootstrap-inbox",
					content: JSON.stringify(request),
				}),
			).resolves.toBe(true);

			expect(callback).toHaveBeenCalledWith({
				from: 99,
				senderInboxId: "ambiguous-bootstrap-inbox",
				message: request,
			});
		});

		it("should ignore injected connectionId metadata on bootstrap connection/request", async () => {
			const bootstrapTrustStore = createAmbiguousTrustStore({
				getContact: vi.fn(async () => BOB_CONTACT),
			});
			const resolver = createBobResolver();
			const transportWithResolver = new XmtpTransport(
				{
					...TEST_CONFIG,
					agentResolver: resolver,
				},
				bootstrapTrustStore,
			);
			injectMockClient(transportWithResolver);

			mockSetup.setInboxIdentifiers("spoofed-bootstrap-metadata-inbox", [
				{ identifier: ALICE.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "queued",
				}),
			);
			transportWithResolver.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "conn-bootstrap-metadata-spoof",
				params: {
					from: { agentId: 99, chain: "eip155:1" },
					to: { agentId: 1, chain: "eip155:1" },
					message: {
						metadata: {
							trustedAgent: {
								connectionId: BOB_CONTACT.connectionId,
							},
						},
					},
					timestamp: new Date().toISOString(),
				},
			};

			await internals(transportWithResolver).processMessage({
				senderInboxId: "spoofed-bootstrap-metadata-inbox",
				content: JSON.stringify(request),
			});

			expect(callback).not.toHaveBeenCalled();
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalled();
		});

		it("should route message/send by connection id when address lookup is ambiguous", async () => {
			const ambiguousTrustStore = createAmbiguousTrustStore({
				getContact: vi.fn(
					async (connectionId: string) =>
						[BOB_CONTACT, BOB_CONTACT_LEGACY].find(
							(contact) => contact.connectionId === connectionId,
						) ?? null,
				),
			});
			const exactTransport = new XmtpTransport(TEST_CONFIG, ambiguousTrustStore);
			injectMockClient(exactTransport);

			mockSetup.setInboxIdentifiers("ambiguous-message-inbox", [
				{ identifier: BOB.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			exactTransport.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "msg-ambiguous-address",
				params: {
					message: {
						messageId: "message-1",
						role: "user",
						parts: [{ kind: "text", text: "hello" }],
						metadata: {
							trustedAgent: {
								connectionId: BOB_CONTACT.connectionId,
								conversationId: "conv-1",
								scope: "general-chat",
								requiresHumanApproval: false,
							},
						},
					},
				},
			};

			await expect(
				internals(exactTransport).processMessage({
					senderInboxId: "ambiguous-message-inbox",
					content: JSON.stringify(request),
				}),
			).resolves.toBe(true);

			expect(callback).toHaveBeenCalledWith({
				from: BOB_CONTACT.peerAgentId,
				senderInboxId: "ambiguous-message-inbox",
				message: request,
			});
		});

		it("should route permissions/update by grantor identity when address lookup is ambiguous", async () => {
			const ambiguousTrustStore = createAmbiguousTrustStore({
				findByAgentId: vi.fn(
					async (agentId: number, chain: string) =>
						[BOB_CONTACT, BOB_CONTACT_LEGACY].find(
							(contact) => contact.peerAgentId === agentId && contact.peerChain === chain,
						) ?? null,
				),
			});
			const exactTransport = new XmtpTransport(TEST_CONFIG, ambiguousTrustStore);
			injectMockClient(exactTransport);

			mockSetup.setInboxIdentifiers("ambiguous-permissions-inbox", [
				{ identifier: BOB.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			exactTransport.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "permissions/update",
				id: "grant-ambiguous-address",
				params: {
					grantSet: { grants: [] },
					grantor: { agentId: BOB_CONTACT.peerAgentId, chain: BOB_CONTACT.peerChain },
					grantee: { agentId: 1, chain: "eip155:1" },
					timestamp: new Date().toISOString(),
				},
			};

			await expect(
				internals(exactTransport).processMessage({
					senderInboxId: "ambiguous-permissions-inbox",
					content: JSON.stringify(request),
				}),
			).resolves.toBe(true);

			expect(callback).toHaveBeenCalledWith({
				from: BOB_CONTACT.peerAgentId,
				senderInboxId: "ambiguous-permissions-inbox",
				message: request,
			});
		});

		it("should reject spoofed bootstrap connection/request sender", async () => {
			const resolver = createBobResolver({ agentId: 42 });
			const transportWithResolver = new XmtpTransport(
				{
					...TEST_CONFIG,
					agentResolver: resolver,
				},
				trustStore,
			);
			injectMockClient(transportWithResolver);

			// Inbox claims ALICE address, but request claims agentId/address for BOB.
			mockSetup.setInboxIdentifiers("spoofed-inbox", [
				{ identifier: ALICE.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (): Promise<TransportAck> => ({
					status: "queued",
				}),
			);
			transportWithResolver.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "conn-spoof",
				params: {
					from: { agentId: 42, chain: "eip155:1" },
					to: { agentId: 1, chain: "eip155:1" },
					connectionId: "conn-spoof",
					nonce: "spoof",
					timestamp: new Date().toISOString(),
				},
			};

			await internals(transportWithResolver).processMessage({
				senderInboxId: "spoofed-inbox",
				content: JSON.stringify(request),
			});

			expect(callback).not.toHaveBeenCalled();
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalled();
		});

		it("should bootstrap-verify connection/result senders for legacy non-active contacts", async () => {
			const legacyContactStore = createMockTrustStore([
				{
					...BOB_CONTACT,
					status: "pending",
				} as unknown as Contact,
			]);
			const resolver = createBobResolver({
				agentId: BOB_CONTACT.peerAgentId,
				capabilities: ["connection/result"],
			});
			const transportWithResolver = new XmtpTransport(
				{
					...TEST_CONFIG,
					agentResolver: resolver,
				},
				legacyContactStore,
			);
			injectMockClient(transportWithResolver);

			mockSetup.setInboxIdentifiers("legacy-inbox", [
				{ identifier: BOB.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transportWithResolver.setHandlers({ onResult: callback });

			const result: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/result",
				id: "conn-result-legacy",
				params: {
					requestId: "conn-request-legacy",
					from: { agentId: BOB_CONTACT.peerAgentId, chain: BOB_CONTACT.peerChain },
					status: "accepted",
					timestamp: new Date().toISOString(),
				},
			};

			await internals(transportWithResolver).processMessage({
				senderInboxId: "legacy-inbox",
				content: JSON.stringify(result),
			});

			expect(callback).toHaveBeenCalledWith({
				from: BOB_CONTACT.peerAgentId,
				senderInboxId: "legacy-inbox",
				message: result,
			});
		});

		it("should ignore injected connectionId metadata on bootstrap connection/result", async () => {
			const bootstrapTrustStore = createAmbiguousTrustStore({
				getContact: vi.fn(async () => BOB_CONTACT),
			});
			const resolver = createBobResolver({
				agentId: BOB_CONTACT.peerAgentId,
				capabilities: ["connection/result"],
			});
			const transportWithResolver = new XmtpTransport(
				{
					...TEST_CONFIG,
					agentResolver: resolver,
				},
				bootstrapTrustStore,
			);
			injectMockClient(transportWithResolver);

			mockSetup.setInboxIdentifiers("spoofed-bootstrap-result-inbox", [
				{ identifier: ALICE.address, identifierKind: 0 },
			]);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transportWithResolver.setHandlers({ onResult: callback });

			const result: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/result",
				id: "conn-result-metadata-spoof",
				params: {
					requestId: "conn-request-legacy",
					from: { agentId: BOB_CONTACT.peerAgentId, chain: BOB_CONTACT.peerChain },
					status: "accepted",
					message: {
						metadata: {
							trustedAgent: {
								connectionId: BOB_CONTACT.connectionId,
							},
						},
					},
					timestamp: new Date().toISOString(),
				},
			};

			await internals(transportWithResolver).processMessage({
				senderInboxId: "spoofed-bootstrap-result-inbox",
				content: JSON.stringify(result),
			});

			expect(callback).not.toHaveBeenCalled();
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalled();
		});

		it("should reject messages from known contacts that are not active", async () => {
			const pendingContactStore = createMockTrustStore([
				{
					...BOB_CONTACT,
					status: "pending",
				},
			]);
			const transportWithPendingContact = new XmtpTransport(TEST_CONFIG, pendingContactStore);
			injectMockClient(transportWithPendingContact);

			internals(transportWithPendingContact).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const callback = vi.fn(
				async (): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transportWithPendingContact.setHandlers({ onRequest: callback });

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "inactive-msg",
			};

			await internals(transportWithPendingContact).processMessage({
				senderInboxId: BOB_INBOX_ID,
				content: JSON.stringify(request),
			});

			expect(callback).not.toHaveBeenCalled();
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalled();
		});
	});

	describe("reconcile", () => {
		it("baselines existing DM history on first reconcile and only processes later messages", async () => {
			injectMockClient();

			internals(transport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transport.setHandlers({ onRequest: callback });

			const oldMsg = makeDmMessage("old-msg");
			mockSetup.setConversationMessages("dm-1", [oldMsg]);

			await expect(transport.reconcile()).resolves.toEqual({
				synced: true,
				processed: 0,
			});
			expect(callback).not.toHaveBeenCalled();

			mockSetup.setConversationMessages("dm-1", [
				oldMsg,
				makeDmMessage("new-msg", { sentAtNs: 2_000n }),
			]);

			await expect(transport.reconcile()).resolves.toEqual({
				synced: true,
				processed: 1,
			});
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith({
				from: 42,
				senderInboxId: BOB_INBOX_ID,
				message: { jsonrpc: "2.0", method: "message/send", id: "new-msg" },
			});
		});

		it("processes the first message from conversations created after the baseline", async () => {
			injectMockClient();

			internals(transport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transport.setHandlers({ onRequest: callback });

			mockSetup.setConversationMessages("dm-existing", [
				makeDmMessage("existing-msg", { conversationId: "dm-existing" }),
			]);

			await transport.reconcile();
			expect(callback).not.toHaveBeenCalled();

			mockSetup.setConversationMessages("dm-new", [
				makeDmMessage("first-msg", { sentAtNs: 2_000n, conversationId: "dm-new" }),
			]);

			await expect(transport.reconcile()).resolves.toEqual({
				synced: true,
				processed: 1,
			});
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith({
				from: 42,
				senderInboxId: BOB_INBOX_ID,
				message: { jsonrpc: "2.0", method: "message/send", id: "first-msg" },
			});
		});

		it("does not stall on a poison message — advances past failures and keeps processing the DM", async () => {
			// Regression: a single message whose processMessage throws must not
			// block all subsequent messages in the same DM. Previously (v0.2.0-beta.4)
			// reconcileConversation returned on the first per-message failure without
			// advancing the checkpoint, so every subsequent reconcile pass retried the
			// same poison message forever and never delivered later messages.
			injectMockClient();
			internals(transport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const callback = vi.fn(
				async (_envelope: InboundRequestEnvelope): Promise<TransportAck> => ({
					status: "received",
				}),
			);
			transport.setHandlers({ onRequest: callback });

			// Baseline at head — no messages processed.
			await transport.reconcile();

			// Inject three new messages: the first will throw, the others are good.
			mockSetup.setConversationMessages("dm-1", [
				makeDmMessage("poison", { sentAtNs: 2_000n }),
				makeDmMessage("good-a", { sentAtNs: 3_000n }),
				makeDmMessage("good-b", { sentAtNs: 4_000n }),
			]);

			const originalProcessMessage = internals(transport).processMessage.bind(transport);
			const processSpy = vi
				.spyOn(internals(transport), "processMessage")
				.mockImplementation(async (msg: unknown) => {
					const message = msg as { messageId?: string };
					if (message.messageId === "poison") {
						throw new Error("simulated unrecoverable handler failure");
					}
					return originalProcessMessage(msg);
				});

			const result = await transport.reconcile();

			// The poison message must be reported as an error, but both good messages
			// must still be processed in the same reconcile pass.
			expect(result.errors).toBeGreaterThanOrEqual(1);
			expect(result.processed).toBe(2);
			expect(callback).toHaveBeenCalledTimes(2);
			expect(callback.mock.calls.map((c) => (c[0] as InboundRequestEnvelope).message.id)).toEqual([
				"good-a",
				"good-b",
			]);

			// Checkpoint must have advanced past all three messages so the next
			// reconcile pass sees none of them again.
			processSpy.mockClear();
			callback.mockClear();

			const second = await transport.reconcile();
			expect(second.processed).toBe(0);
			expect(second.errors ?? 0).toBe(0);
			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("stop", () => {
		it("should reject all pending requests on stop", async () => {
			injectMockClient();

			const pendingPromise = new Promise<TransportReceipt>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timeout")), 30000);
				internals(transport).pendingRequests.set("stop-test", {
					resolve,
					reject,
					timer,
					senderInboxId: "stop-test-inbox",
				});
			});

			await transport.stop();

			await expect(pendingPromise).rejects.toThrow("stopped");
		});
	});

	describe("isReachable", () => {
		it("should check XMTP reachability for known contacts", async () => {
			injectMockClient();

			const reachable = await transport.isReachable(42);
			expect(reachable).toBe(true);
			expect(mockSetup.client.canMessage).toHaveBeenCalled();
		});

		it("should return false for unknown contacts", async () => {
			injectMockClient();

			const reachable = await transport.isReachable(999);
			expect(reachable).toBe(false);
		});
	});

	describe("setHandlers", () => {
		it("should register request handlers", () => {
			const callback = vi.fn();
			transport.setHandlers({ onRequest: callback });
			expect(internals(transport).handlers.onRequest).toBe(callback);
		});
	});

	describe("streaming", () => {
		it("starts the DM stream without an implicit sync", async () => {
			injectMockClient();

			const listenPromise = internals(transport).listenForMessages();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mockSetup.client.conversations.streamAllDmMessages).toHaveBeenCalledTimes(1);
			await transport.stop();
			await listenPromise;

			expect(mockSetup.streamOptions).toEqual([{ disableSync: true }]);
		});

		it("closes the DM stream if stop occurs while the stream is opening", async () => {
			const streamReady = createDeferred<{
				[Symbol.asyncIterator](): AsyncIterator<MockMessage>;
				next(): Promise<IteratorResult<MockMessage>>;
				return(): Promise<IteratorResult<MockMessage>>;
			}>();
			const streamReturn = vi.fn(async () => ({ value: undefined, done: true as const }));
			const streamNext = vi.fn(() => new Promise<IteratorResult<MockMessage>>(() => {}));
			const stream = {
				[Symbol.asyncIterator]() {
					return this;
				},
				next: streamNext,
				return: streamReturn,
			};
			mockSetup.client.conversations.streamAllDmMessages.mockImplementationOnce(
				async () => await streamReady.promise,
			);
			injectMockClient();

			internals(transport).listenWithReconnect();
			await sleep(10);
			await transport.stop();
			streamReady.resolve(stream);

			await vi.waitFor(() => expect(streamReturn).toHaveBeenCalledTimes(1));
			expect(streamNext).not.toHaveBeenCalled();
		});

		it("processes streamed messages sequentially before advancing to the next one", async () => {
			injectMockClient();

			internals(transport).inboxIdToAddress.set(BOB_INBOX_ID, BOB.address);

			const firstRequestGate = createDeferred<void>();
			const callback = vi.fn(async (envelope: InboundRequestEnvelope): Promise<TransportAck> => {
				if (envelope.message.id === "stream-msg-1") {
					await firstRequestGate.promise;
				}
				return { status: "received" };
			});
			transport.setHandlers({ onRequest: callback });

			const listenPromise = internals(transport).listenForMessages();
			await sleep(10);

			mockSetup.pushMessage(
				makeDmMessage("stream-entry-1", { conversationId: "dm-sequential", rpcId: "stream-msg-1" }),
			);
			mockSetup.pushMessage(
				makeDmMessage("stream-entry-2", {
					sentAtNs: 2_000n,
					conversationId: "dm-sequential",
					rpcId: "stream-msg-2",
				}),
			);

			await sleep(25);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					message: expect.objectContaining({ id: "stream-msg-1" }),
				}),
			);

			firstRequestGate.resolve();
			await sleep(25);
			expect(callback).toHaveBeenCalledTimes(2);
			expect(callback).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					message: expect.objectContaining({ id: "stream-msg-2" }),
				}),
			);

			await transport.stop();
			await listenPromise;
		});
	});
});
