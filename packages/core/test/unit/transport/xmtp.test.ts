import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import type { ProtocolMessage, ProtocolResponse } from "../../../src/transport/interface.js";
import type { XmtpTransportConfig } from "../../../src/transport/xmtp-types.js";
import { XmtpTransport } from "../../../src/transport/xmtp.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE, BOB } from "../../fixtures/test-keys.js";

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

	const client = {
		inboxId: clientInboxId,
		conversations: {
			streamAllDmMessages: vi.fn(async () => {
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
		pushMessage: (msg: MockMessage) => {
			for (const listener of messageListeners) {
				listener(msg);
			}
		},
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
	privateKey: ALICE.privateKey,
	chain: "eip155:1",
	env: "dev",
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

describe("XmtpTransport", () => {
	let transport: XmtpTransport;
	let trustStore: ITrustStore;
	let mockSetup: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		trustStore = createMockTrustStore([BOB_CONTACT]);
		transport = new XmtpTransport(TEST_CONFIG, trustStore);
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
				const responseJson: ProtocolResponse = {
					jsonrpc: "2.0",
					id: "msg-1",
					result: { ok: true },
				};
				const pending = internals(transport).pendingRequests.get("msg-1");
				if (pending) {
					clearTimeout(pending.timer);
					internals(transport).pendingRequests.delete("msg-1");
					pending.resolve(responseJson);
				}
			}, 50);

			const response = await transport.send(42, message);

			expect(response.jsonrpc).toBe("2.0");
			expect(response.id).toBe("msg-1");
			expect(response.result).toEqual({ ok: true });
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
				const responseJson: ProtocolResponse = {
					jsonrpc: "2.0",
					id: "direct-msg",
					result: { accepted: true },
				};
				const pending = internals(transport).pendingRequests.get("direct-msg");
				if (pending) {
					clearTimeout(pending.timer);
					internals(transport).pendingRequests.delete("direct-msg");
					pending.resolve(responseJson);
				}
			}, 50);

			const response = await transport.send(999, message, {
				peerAddress: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
			});

			expect(response.result).toEqual({ accepted: true });
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
		it("should skip self-messages", async () => {
			injectMockClient();

			const callback = vi.fn(async () => ({
				jsonrpc: "2.0" as const,
				id: "1",
				result: {},
			}));
			transport.onMessage(callback);

			await internals(transport).processMessage({
				senderInboxId: mockSetup.client.inboxId,
				content: JSON.stringify({
					jsonrpc: "2.0",
					method: "test/method",
					id: "1",
				}),
			});

			expect(callback).not.toHaveBeenCalled();
		});

		it("should skip non-string content", async () => {
			injectMockClient();

			const callback = vi.fn();
			transport.onMessage(callback);

			await internals(transport).processMessage({
				senderInboxId: "other-inbox",
				content: 12345,
			});

			expect(callback).not.toHaveBeenCalled();
		});

		it("should skip non-JSON content", async () => {
			injectMockClient();

			const callback = vi.fn();
			transport.onMessage(callback);

			await internals(transport).processMessage({
				senderInboxId: "other-inbox",
				content: "not json at all",
			});

			expect(callback).not.toHaveBeenCalled();
		});

		it("should skip non-JSON-RPC messages", async () => {
			injectMockClient();

			const callback = vi.fn();
			transport.onMessage(callback);

			await internals(transport).processMessage({
				senderInboxId: "other-inbox",
				content: JSON.stringify({ hello: "world" }),
			});

			expect(callback).not.toHaveBeenCalled();
		});

		it("should resolve pending request when response arrives", async () => {
			injectMockClient();

			const responseData: ProtocolResponse = {
				jsonrpc: "2.0",
				id: "req-123",
				result: { data: "test" },
			};

			// Set up a pending request
			let resolved: ProtocolResponse | undefined;
			const timer = setTimeout(() => {}, 30000);
			internals(transport).pendingRequests.set("req-123", {
				resolve: (r: ProtocolResponse) => {
					resolved = r;
				},
				reject: () => {},
				timer,
			});

			await internals(transport).processMessage({
				senderInboxId: "other-inbox",
				content: JSON.stringify(responseData),
			});

			expect(resolved).toBeDefined();
			expect(resolved!.result).toEqual({ data: "test" });
			expect(internals(transport).pendingRequests.has("req-123")).toBe(false);
		});

		it("should route incoming requests to message callback for known contacts", async () => {
			injectMockClient();

			// Register BOB's inbox -> address mapping
			const bobInboxId = `inbox-for-${BOB.address.toLowerCase()}`;
			internals(transport).inboxIdToAddress.set(bobInboxId, BOB.address);

			const callback = vi.fn(async (_from: number, _msg: ProtocolMessage) => ({
				jsonrpc: "2.0" as const,
				id: _msg.id,
				result: { handled: true },
			}));
			transport.onMessage(callback);

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "req-456",
			};

			await internals(transport).processMessage({
				senderInboxId: bobInboxId,
				content: JSON.stringify(request),
			});

			expect(callback).toHaveBeenCalledWith(42, request);
		});

		it("should ignore duplicate inbound requests with the same sender and request id", async () => {
			injectMockClient();

			const bobInboxId = `inbox-for-${BOB.address.toLowerCase()}`;
			internals(transport).inboxIdToAddress.set(bobInboxId, BOB.address);

			const callback = vi.fn(async (_from: number, _msg: ProtocolMessage) => ({
				jsonrpc: "2.0" as const,
				id: _msg.id,
				result: { handled: true },
			}));
			transport.onMessage(callback);

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "req-duplicate",
			};

			await internals(transport).processMessage({
				senderInboxId: bobInboxId,
				content: JSON.stringify(request),
			});
			await internals(transport).processMessage({
				senderInboxId: bobInboxId,
				content: JSON.stringify(request),
			});

			expect(callback).toHaveBeenCalledTimes(1);
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalledTimes(1);
		});

		it("should reject non-bootstrap requests from unknown senders", async () => {
			injectMockClient();

			const callback = vi.fn(async () => ({
				jsonrpc: "2.0" as const,
				id: "ignored",
				result: { ok: true },
			}));
			transport.onMessage(callback);

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
			const resolver = {
				resolve: vi.fn(),
				resolveWithCache: vi.fn(async () => ({
					agentId: 99,
					chain: "eip155:1",
					ownerAddress: BOB.address,
					agentAddress: BOB.address,
					xmtpEndpoint: BOB.address,
					endpoint: undefined,
					capabilities: ["message/send"],
					registrationFile: {
						type: "eip-8004-registration-v1" as const,
						name: "Bob",
						description: "Test",
						services: [{ name: "xmtp", endpoint: BOB.address }],
						trustedAgentProtocol: {
							version: "1.0",
							agentAddress: BOB.address,
							capabilities: ["message/send"],
						},
					},
					resolvedAt: new Date().toISOString(),
				})),
			};
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

			const callback = vi.fn(async (_from: number, _msg: ProtocolMessage) => ({
				jsonrpc: "2.0" as const,
				id: _msg.id,
				result: { accepted: true },
			}));
			transportWithResolver.onMessage(callback);

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "conn-1",
				params: {
					from: { agentId: 99, chain: "eip155:1" },
					to: { agentId: 1, chain: "eip155:1" },
					nonce: "abc",
					timestamp: new Date().toISOString(),
				},
			};

			await internals(transportWithResolver).processMessage({
				senderInboxId: "unknown-inbox",
				content: JSON.stringify(request),
			});

			expect(callback).toHaveBeenCalledWith(99, request);
		});

		it("should reject spoofed bootstrap connection/request sender", async () => {
			const resolver = {
				resolve: vi.fn(),
				resolveWithCache: vi.fn(async () => ({
					agentId: 42,
					chain: "eip155:1",
					ownerAddress: BOB.address,
					agentAddress: BOB.address,
					xmtpEndpoint: BOB.address,
					endpoint: undefined,
					capabilities: ["message/send"],
					registrationFile: {
						type: "eip-8004-registration-v1" as const,
						name: "Bob",
						description: "Test",
						services: [{ name: "xmtp", endpoint: BOB.address }],
						trustedAgentProtocol: {
							version: "1.0",
							agentAddress: BOB.address,
							capabilities: ["message/send"],
						},
					},
					resolvedAt: new Date().toISOString(),
				})),
			};
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

			const callback = vi.fn(async () => ({
				jsonrpc: "2.0" as const,
				id: "ignored",
				result: { accepted: true },
			}));
			transportWithResolver.onMessage(callback);

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/request",
				id: "conn-spoof",
				params: {
					from: { agentId: 42, chain: "eip155:1" },
					to: { agentId: 1, chain: "eip155:1" },
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

		it("should reject messages from known contacts that are not active", async () => {
			const pendingContactStore = createMockTrustStore([
				{
					...BOB_CONTACT,
					status: "pending",
				},
			]);
			const transportWithPendingContact = new XmtpTransport(TEST_CONFIG, pendingContactStore);
			injectMockClient(transportWithPendingContact);

			const bobInboxId = `inbox-for-${BOB.address.toLowerCase()}`;
			internals(transportWithPendingContact).inboxIdToAddress.set(bobInboxId, BOB.address);

			const callback = vi.fn(async () => ({
				jsonrpc: "2.0" as const,
				id: "ignored",
				result: { ok: true },
			}));
			transportWithPendingContact.onMessage(callback);

			const request: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "inactive-msg",
			};

			await internals(transportWithPendingContact).processMessage({
				senderInboxId: bobInboxId,
				content: JSON.stringify(request),
			});

			expect(callback).not.toHaveBeenCalled();
			expect(mockSetup.mockConversation.sendText).toHaveBeenCalled();
		});
	});

	describe("stop", () => {
		it("should reject all pending requests on stop", async () => {
			injectMockClient();

			const pendingPromise = new Promise<ProtocolResponse>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timeout")), 30000);
				internals(transport).pendingRequests.set("stop-test", { resolve, reject, timer });
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

	describe("onMessage", () => {
		it("should register message callback", () => {
			const callback = vi.fn();
			transport.onMessage(callback);
			expect(internals(transport).messageCallback).toBe(callback);
		});
	});
});
