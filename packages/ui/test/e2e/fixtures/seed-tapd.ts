import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGrantSet } from "trusted-agents-core";
import { Daemon } from "trusted-agents-tapd";

/**
 * Spins up an in-process tapd Daemon against a temp data dir, with stub
 * stores that return one identity, one active contact (Bob), and one
 * conversation with two seeded messages. The Daemon is configured to serve
 * the freshly-built UI from `packages/ui/out/` so Playwright can navigate to
 * the static export over real HTTP.
 *
 * Returns the URL, bearer token, and a cleanup hook.
 */

export interface SeededTapd {
	url: string;
	token: string;
	dataDir: string;
	daemon: Daemon;
	cleanup: () => Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_OUT_DIR = resolve(HERE, "..", "..", "..", "out");

export async function seedTapd(): Promise<SeededTapd> {
	const dataDir = await mkdtemp(join(tmpdir(), "tapd-e2e-"));

	const seedContact = makeSeedContact();
	const seedConversation = makeSeedConversation();

	const fakeService = {
		hooks: {} as { emitEvent?: (payload: Record<string, unknown>) => void },
		start: async () => {},
		stop: async () => {},
		getStatus: async () => ({
			running: true,
			lock: null,
			pendingRequests: [],
		}),
		resolvePending: async () => ({}),
		syncOnce: async () => ({
			synced: true,
			processed: 0,
			pendingRequests: [],
			pendingDeliveries: [],
		}),
	};

	const trustStore = {
		getContacts: async () => [seedContact],
		getContact: async (id: string) => (id === seedContact.connectionId ? seedContact : null),
	};

	const conversationLogger = {
		logMessage: async () => {},
		getConversation: async (id: string) =>
			id === seedConversation.conversationId ? seedConversation : null,
		listConversations: async () => [seedConversation],
		generateTranscript: async () => "",
		markRead: async () => {},
	};

	const daemon = new Daemon({
		config: {
			dataDir,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			ringBufferSize: 100,
		},
		identityAgentId: 42,
		identitySource: () => ({
			agentId: 42,
			chain: "eip155:8453",
			address: "0xa1ce000000000000000000000000000000000000",
			displayName: "Alice",
			dataDir,
		}),
		buildService: async () => fakeService as never,
		trustStore: trustStore as never,
		conversationLogger: conversationLogger as never,
		staticAssetsDir: UI_OUT_DIR,
	});

	await daemon.start();
	const port = daemon.boundTcpPort();
	const token = daemon.authToken();

	return {
		url: `http://127.0.0.1:${port}`,
		token,
		dataDir,
		daemon,
		cleanup: async () => {
			await daemon.stop().catch(() => {});
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

function makeSeedContact() {
	return {
		connectionId: "conn-bob",
		peerAgentId: 108,
		peerChain: "eip155:8453",
		peerOwnerAddress: "0xbb00000000000000000000000000000000000000",
		peerDisplayName: "Bob",
		peerAgentAddress: "0xbb00000000000000000000000000000000000000",
		permissions: {
			grantedByMe: createGrantSet([], "2026-04-01T00:00:00.000Z"),
			grantedByPeer: createGrantSet([], "2026-04-01T00:00:00.000Z"),
		},
		establishedAt: "2026-04-01T00:00:00.000Z",
		lastContactAt: "2026-04-01T00:05:00.000Z",
		status: "active" as const,
	};
}

function makeSeedConversation() {
	return {
		conversationId: "conv-bob",
		connectionId: "conn-bob",
		peerAgentId: 108,
		peerDisplayName: "Bob",
		startedAt: "2026-04-01T00:00:00.000Z",
		lastMessageAt: "2026-04-01T00:05:00.000Z",
		status: "active" as const,
		messages: [
			{
				messageId: "m1",
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "incoming" as const,
				scope: "default",
				content:
					"Hey — thanks for connecting. My operator said you'd probably want to settle up for lunch.",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				messageId: "m2",
				timestamp: "2026-04-01T00:05:00.000Z",
				direction: "outgoing" as const,
				scope: "default",
				content: "Sure thing — sending $10 now.",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
		],
	};
}
