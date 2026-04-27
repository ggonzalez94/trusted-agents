import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../common/atomic-json.js";
import { AsyncMutex, fsErrorCode, nowISO } from "../common/index.js";

export interface XmtpConversationCheckpoint {
	lastSentAtNs: string;
	lastMessageIds: string[];
}

interface XmtpSyncStateFile {
	version: 1;
	initializedAt?: string;
	conversations: Record<string, XmtpConversationCheckpoint>;
}

const EMPTY_STATE: XmtpSyncStateFile = {
	version: 1,
	conversations: {},
};

export class FileXmtpSyncStateStore {
	private readonly writeMutex = new AsyncMutex();

	constructor(
		private readonly path = join(process.env.HOME ?? "~", ".trustedagents", "xmtp-sync-state.json"),
	) {}

	async isInitialized(): Promise<boolean> {
		const state = await this.load();
		return typeof state.initializedAt === "string" && state.initializedAt.length > 0;
	}

	async getCheckpoint(conversationId: string): Promise<XmtpConversationCheckpoint | null> {
		const state = await this.load();
		return state.conversations[conversationId] ?? null;
	}

	async initializeAtHead(
		checkpoints: Record<string, XmtpConversationCheckpoint>,
	): Promise<{ initialized: boolean; state: XmtpSyncStateFile }> {
		return this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			if (state.initializedAt) {
				return { initialized: false, state };
			}

			for (const [conversationId, checkpoint] of Object.entries(checkpoints)) {
				state.conversations[conversationId] = mergeCheckpoints(
					state.conversations[conversationId],
					checkpoint,
				);
			}
			state.initializedAt = nowISO();
			await this.save(state);
			return { initialized: true, state };
		});
	}

	async advance(
		conversationId: string,
		message: { sentAtNs: bigint; messageId: string },
	): Promise<XmtpConversationCheckpoint> {
		return this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			const current = state.conversations[conversationId];
			const next = advanceCheckpoint(current, message);
			state.conversations[conversationId] = next;
			await this.save(state);
			return next;
		});
	}

	private async load(): Promise<XmtpSyncStateFile> {
		try {
			const raw = await readFile(this.path, "utf-8");
			const parsed = JSON.parse(raw) as Partial<XmtpSyncStateFile>;
			return {
				version: 1,
				initializedAt:
					typeof parsed.initializedAt === "string" && parsed.initializedAt.length > 0
						? parsed.initializedAt
						: undefined,
				conversations: normalizeConversations(parsed.conversations),
			};
		} catch (error: unknown) {
			if (fsErrorCode(error) === "ENOENT") {
				return { ...EMPTY_STATE, conversations: {} };
			}
			throw error;
		}
	}

	private async save(state: XmtpSyncStateFile): Promise<void> {
		await writeJsonFileAtomic(this.path, state, {
			directoryMode: 0o700,
			tempPrefix: ".xmtp-sync-state",
		});
	}
}

function normalizeConversations(
	conversations: unknown,
): Record<string, XmtpConversationCheckpoint> {
	if (!conversations || typeof conversations !== "object") {
		return {};
	}

	return Object.fromEntries(
		Object.entries(conversations).flatMap(([conversationId, checkpoint]) => {
			const normalized = normalizeCheckpoint(checkpoint);
			return normalized ? [[conversationId, normalized]] : [];
		}),
	);
}

function normalizeCheckpoint(checkpoint: unknown): XmtpConversationCheckpoint | null {
	if (!checkpoint || typeof checkpoint !== "object") {
		return null;
	}

	const candidate = checkpoint as Partial<XmtpConversationCheckpoint>;
	if (typeof candidate.lastSentAtNs !== "string" || candidate.lastSentAtNs.length === 0) {
		return null;
	}

	const lastMessageIds = Array.isArray(candidate.lastMessageIds)
		? [
				...new Set(
					candidate.lastMessageIds.filter((value): value is string => typeof value === "string"),
				),
			]
		: [];

	return {
		lastSentAtNs: candidate.lastSentAtNs,
		lastMessageIds,
	};
}

function mergeCheckpoints(
	current: XmtpConversationCheckpoint | undefined,
	incoming: XmtpConversationCheckpoint,
): XmtpConversationCheckpoint {
	if (!current) {
		return normalizeCheckpoint(incoming) ?? incoming;
	}

	const currentNs = BigInt(current.lastSentAtNs);
	const incomingNs = BigInt(incoming.lastSentAtNs);
	if (incomingNs > currentNs) {
		return normalizeCheckpoint(incoming) ?? incoming;
	}
	if (incomingNs < currentNs) {
		return current;
	}

	return {
		lastSentAtNs: current.lastSentAtNs,
		lastMessageIds: [...new Set([...current.lastMessageIds, ...incoming.lastMessageIds])],
	};
}

function advanceCheckpoint(
	current: XmtpConversationCheckpoint | undefined,
	message: { sentAtNs: bigint; messageId: string },
): XmtpConversationCheckpoint {
	if (!current) {
		return {
			lastSentAtNs: message.sentAtNs.toString(),
			lastMessageIds: [message.messageId],
		};
	}

	const currentNs = BigInt(current.lastSentAtNs);
	if (message.sentAtNs > currentNs) {
		return {
			lastSentAtNs: message.sentAtNs.toString(),
			lastMessageIds: [message.messageId],
		};
	}
	if (message.sentAtNs < currentNs) {
		return current;
	}

	if (current.lastMessageIds.includes(message.messageId)) {
		return current;
	}

	return {
		lastSentAtNs: current.lastSentAtNs,
		lastMessageIds: [...current.lastMessageIds, message.messageId],
	};
}
