import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationLogger } from "../../../src/conversation/sqlite-logger.js";
import type { ConversationMessage } from "../../../src/conversation/types.js";

function makeMessage(timestamp: string, content: string): ConversationMessage {
	return {
		timestamp,
		direction: "outgoing",
		scope: "default",
		content,
		humanApprovalRequired: false,
		humanApprovalGiven: null,
	};
}

describe("SqliteConversationLogger", () => {
	let dataDir: string;
	let logger: SqliteConversationLogger;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "sqlite-conv-test-"));
		logger = new SqliteConversationLogger(dataDir);
	});

	afterEach(async () => {
		logger.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("creates a new conversation on first message", async () => {
		await logger.logMessage(
			"conv-1",
			{
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "outgoing",
				scope: "default",
				content: "hello",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
			},
		);

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(1);
		expect(log?.peerDisplayName).toBe("Alice");
		expect(log?.startedAt).toBe("2026-04-01T00:00:00.000Z");
		expect(log?.lastMessageAt).toBe("2026-04-01T00:00:00.000Z");
		expect(log?.status).toBe("active");
	});

	it("throws when creating a new conversation without context", async () => {
		await expect(
			logger.logMessage("conv-orphan", makeMessage("2026-04-01T00:00:00.000Z", "x")),
		).rejects.toThrow(/context is required/i);
	});

	it("appends to an existing conversation", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "first"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:01:00.000Z", "second"));

		const log = await logger.getConversation("conv-1");
		expect(log?.messages.map((m) => m.content)).toEqual(["first", "second"]);
		expect(log?.lastMessageAt).toBe("2026-04-01T00:01:00.000Z");
	});

	it("dedupes by messageId+direction", async () => {
		const ctx = {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		};
		await logger.logMessage(
			"conv-1",
			{ ...makeMessage("2026-04-01T00:00:00.000Z", "first"), messageId: "m1" },
			ctx,
		);
		await logger.logMessage("conv-1", {
			...makeMessage("2026-04-01T00:00:00.000Z", "first"),
			messageId: "m1",
		});
		await logger.logMessage("conv-1", {
			...makeMessage("2026-04-01T00:00:00.000Z", "first"),
			messageId: "m1",
		});

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(1);
	});

	it("does not dedupe when messageId differs by direction", async () => {
		const ctx = {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		};
		await logger.logMessage(
			"conv-1",
			{ ...makeMessage("2026-04-01T00:00:00.000Z", "out"), messageId: "m1" },
			ctx,
		);
		await logger.logMessage("conv-1", {
			timestamp: "2026-04-01T00:00:01.000Z",
			direction: "incoming",
			scope: "default",
			content: "in",
			messageId: "m1",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		});

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(2);
	});

	it("updates topic when context provides it", async () => {
		const ctx = {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		};
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "a"), ctx);
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:01:00.000Z", "b"), {
			...ctx,
			topic: "New topic",
		});
		const log = await logger.getConversation("conv-1");
		expect(log?.topic).toBe("New topic");
	});

	it("returns null for unknown conversation", async () => {
		expect(await logger.getConversation("nope")).toBeNull();
	});

	it("listConversations sorts by lastMessageAt DESC", async () => {
		await logger.logMessage("conv-a", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
			connectionId: "ca",
			peerAgentId: 1,
			peerDisplayName: "A",
		});
		await logger.logMessage("conv-b", makeMessage("2026-04-03T00:00:00.000Z", "x"), {
			connectionId: "cb",
			peerAgentId: 2,
			peerDisplayName: "B",
		});
		await logger.logMessage("conv-c", makeMessage("2026-04-02T00:00:00.000Z", "x"), {
			connectionId: "cc",
			peerAgentId: 3,
			peerDisplayName: "C",
		});

		const all = await logger.listConversations();
		expect(all.map((c) => c.conversationId)).toEqual(["conv-b", "conv-c", "conv-a"]);
	});

	it("listConversations filters by connectionId", async () => {
		await logger.logMessage("conv-a", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
			connectionId: "ca",
			peerAgentId: 1,
			peerDisplayName: "A",
		});
		await logger.logMessage("conv-b", makeMessage("2026-04-02T00:00:00.000Z", "x"), {
			connectionId: "cb",
			peerAgentId: 2,
			peerDisplayName: "B",
		});

		const filtered = await logger.listConversations({ connectionId: "cb" });
		expect(filtered.map((c) => c.conversationId)).toEqual(["conv-b"]);
	});

	it("listConversations returns [] when no conversations exist", async () => {
		expect(await logger.listConversations()).toEqual([]);
	});

	it("markRead updates lastReadAt", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});

		await logger.markRead("conv-1", "2026-04-01T00:01:00.000Z");
		const log = await logger.getConversation("conv-1");
		expect(log?.lastReadAt).toBe("2026-04-01T00:01:00.000Z");
	});

	it("markRead is a no-op for unknown conversations", async () => {
		await logger.markRead("nope", "2026-04-01T00:00:00.000Z");
		expect(await logger.getConversation("nope")).toBeNull();
	});

	it("generateTranscript returns markdown for an existing conversation", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "hello from test"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});
		const md = await logger.generateTranscript("conv-1");
		expect(md).toContain("hello from test");
		expect(md).toContain("Alice");
	});

	it("generateTranscript returns empty string for unknown conversations", async () => {
		expect(await logger.generateTranscript("nope")).toBe("");
	});

	it("persists data across instances", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "persisted"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});
		logger.close();

		const second = new SqliteConversationLogger(dataDir);
		const log = await second.getConversation("conv-1");
		expect(log?.messages[0]?.content).toBe("persisted");
		second.close();
	});

	it("preserves humanApproval* fields through a round-trip", async () => {
		await logger.logMessage(
			"conv-1",
			{
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "outgoing",
				scope: "general-chat",
				content: "needs approval",
				humanApprovalRequired: true,
				humanApprovalGiven: true,
				humanApprovalAt: "2026-04-01T00:00:30.000Z",
			},
			{
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
			},
		);

		const log = await logger.getConversation("conv-1");
		expect(log?.messages[0]?.humanApprovalRequired).toBe(true);
		expect(log?.messages[0]?.humanApprovalGiven).toBe(true);
		expect(log?.messages[0]?.humanApprovalAt).toBe("2026-04-01T00:00:30.000Z");
	});

	it("close() is idempotent", () => {
		logger.close();
		expect(() => logger.close()).not.toThrow();
	});

	describe("strict timestamp validation", () => {
		it("rejects rollover dates that Date.parse would silently normalize", async () => {
			// `Date.parse('2026-04-31T00:00:00Z')` returns a real ms value
			// but it points at 2026-05-01 — Date silently rolled over the
			// invalid April 31 to May 1. Pre-fix, canonicalizeTimestamp
			// would persist that rolled-over instant. The validator must
			// reject before canonicalization runs.
			await expect(
				logger.logMessage(
					"conv-rollover",
					{
						timestamp: "2026-04-31T00:00:00Z",
						direction: "outgoing",
						scope: "default",
						content: "april thirty-first does not exist",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
					{ connectionId: "conn-rollover", peerAgentId: 1, peerDisplayName: "X" },
				),
			).rejects.toThrow(/strict ISO 8601/);
		});

		it("rejects non-leap February 29", async () => {
			// 2026 is not a leap year; Date.parse rolls 2026-02-29 forward
			// to 2026-03-01. The validator must reject.
			await expect(
				logger.logMessage(
					"conv-feb29",
					{
						timestamp: "2026-02-29T12:00:00Z",
						direction: "outgoing",
						scope: "default",
						content: "non-leap feb 29",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
					{ connectionId: "conn-feb29", peerAgentId: 1, peerDisplayName: "X" },
				),
			).rejects.toThrow(/strict ISO 8601/);
		});

		it("accepts leap February 29 in actual leap years", async () => {
			// 2024 is a leap year; the validator must NOT reject.
			await logger.logMessage(
				"conv-leap",
				{
					timestamp: "2024-02-29T12:00:00.000Z",
					direction: "outgoing",
					scope: "default",
					content: "leap day",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{ connectionId: "conn-leap", peerAgentId: 1, peerDisplayName: "X" },
			);
			const log = await logger.getConversation("conv-leap");
			expect(log?.messages[0]?.timestamp).toBe("2024-02-29T12:00:00.000Z");
		});

		it("rejects month 13", async () => {
			await expect(
				logger.logMessage(
					"conv-mo",
					{
						timestamp: "2026-13-01T12:00:00Z",
						direction: "outgoing",
						scope: "default",
						content: "month thirteen",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
					{ connectionId: "conn-mo", peerAgentId: 1, peerDisplayName: "X" },
				),
			).rejects.toThrow(/strict ISO 8601/);
		});

		it("rejects timestamps without an explicit offset", async () => {
			// "2026-04-10T12:00:00" parses as host-local time, which is
			// host-dependent. The strict validator must reject the
			// no-offset form.
			await expect(
				logger.logMessage(
					"conv-noo",
					{
						timestamp: "2026-04-10T12:00:00",
						direction: "outgoing",
						scope: "default",
						content: "no offset",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
					{ connectionId: "conn-noo", peerAgentId: 1, peerDisplayName: "X" },
				),
			).rejects.toThrow(/strict ISO 8601/);
		});
	});

	describe("canonicalize backfill on construction", () => {
		it("rewrites pre-canonical timestamps in existing rows when a fresh logger opens the DB", async () => {
			// Simulate a pre-canonicalization-fix install: the logger
			// was last opened by a build that wrote raw mixed-encoding
			// timestamps to SQLite. We do that by writing rows directly
			// via the underlying sqlite handle, then closing and
			// reopening the logger so the construction-time backfill
			// runs.
			//
			// Pre-fix encodings used here:
			//   - Legacy snapshot in "+01:00" form (= noon UTC)
			//   - Whole-second `Z` form (no millis)
			//   - Sub-millisecond `Z` form
			// All three should land back as canonical 24-char `Z` form.
			const db = logger.database;
			db.prepare(
				`INSERT INTO conversations(
					conversation_id, connection_id, peer_agent_id, peer_display_name,
					topic, started_at, last_message_at, last_read_at, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"conv-precanonical",
				"conn-1",
				42,
				"Alice",
				null,
				"2026-04-10T13:00:00+01:00", // = noon UTC
				"2026-04-10T12:00:01Z", // 1s after noon UTC, no millis
				"2026-04-10T12:00:00.500Z", // .5s after noon UTC
				"active",
			);
			db.prepare(
				`INSERT INTO messages(
					conversation_id, message_id, timestamp, direction, scope, content,
					human_approval_required, human_approval_given, human_approval_at, insert_order
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"conv-precanonical",
				"m-1",
				"2026-04-10T13:00:00+01:00",
				"outgoing",
				"default",
				"first",
				0,
				null,
				null,
				1,
			);
			db.prepare(
				`INSERT INTO messages(
					conversation_id, message_id, timestamp, direction, scope, content,
					human_approval_required, human_approval_given, human_approval_at, insert_order
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"conv-precanonical",
				"m-2",
				"2026-04-10T12:00:00.500Z",
				"outgoing",
				"default",
				"second",
				0,
				null,
				"2026-04-10T12:00:00.500Z",
				2,
			);

			// Manually clear ALL backfill checkpoint state so we reach
			// the backfill code path on the next construction. The
			// batched implementation tracks three keys: the legacy
			// completion marker, the per-phase cursor, and the phase
			// indicator. Wipe all three so the backfill restarts
			// cleanly from phase 'conversations' with an empty cursor.
			const wipe = db.prepare("DELETE FROM schema_meta WHERE key = ?");
			wipe.run("canonicalize_timestamps_backfill");
			wipe.run("canonicalize_timestamps_backfill_phase");
			wipe.run("canonicalize_timestamps_backfill_cursor");

			logger.close();

			// Reopen — the constructor calls runCanonicalizeBackfillIfNeeded
			// which scans every row and rewrites non-canonical timestamps.
			const reopened = new SqliteConversationLogger(dataDir);

			const reloaded = await reopened.getConversation("conv-precanonical");
			expect(reloaded).not.toBeNull();
			if (!reloaded) return;

			// Every top-level timestamp now matches the canonical form.
			expect(reloaded.startedAt).toBe("2026-04-10T12:00:00.000Z");
			expect(reloaded.lastMessageAt).toBe("2026-04-10T12:00:01.000Z");
			expect(reloaded.lastReadAt).toBe("2026-04-10T12:00:00.500Z");

			// Every message timestamp is canonical too.
			for (const m of reloaded.messages) {
				expect(m.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			}
			expect(reloaded.messages[0]?.humanApprovalAt ?? null).toBeNull();
			expect(reloaded.messages[1]?.humanApprovalAt).toBe("2026-04-10T12:00:00.500Z");

			// Messages now sort in true temporal order via the existing
			// `ORDER BY timestamp ASC` lexical clause.
			expect(reloaded.messages.map((m) => m.messageId)).toEqual(["m-1", "m-2"]);

			// Re-opening once more is a fast no-op: the marker is set,
			// the backfill skips. Verify by inspecting schema_meta.
			const marker = (
				reopened.database
					.prepare("SELECT value FROM schema_meta WHERE key = ?")
					.get("canonicalize_timestamps_backfill") as { value: string } | undefined
			)?.value;
			expect(marker).toBe("1");

			reopened.close();
		});

		it("backfill is idempotent — safe to construct the logger repeatedly", async () => {
			// Call the constructor a second time on the same DB; the
			// backfill marker is already set, so it must be a no-op
			// and not throw.
			logger.close();
			const second = new SqliteConversationLogger(dataDir);
			second.close();
		});

		it("backfill resumes from a checkpoint when interrupted between batches", async () => {
			// Seed enough rows to span multiple batches (BACKFILL_BATCH_SIZE
			// = 500). We use 12 conversation rows and 12 message rows
			// with a tiny private batch size — the test exercises the
			// resume cursor path by manually setting the phase/cursor
			// after a partial run.
			const db = logger.database;
			const insertConv = db.prepare(
				`INSERT INTO conversations(
					conversation_id, connection_id, peer_agent_id, peer_display_name,
					topic, started_at, last_message_at, last_read_at, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			const insertMsg = db.prepare(
				`INSERT INTO messages(
					conversation_id, message_id, timestamp, direction, scope, content,
					human_approval_required, human_approval_given, human_approval_at, insert_order
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (let i = 0; i < 12; i += 1) {
				const id = `conv-${String(i).padStart(2, "0")}`;
				insertConv.run(
					id,
					"conn-1",
					i,
					`Peer ${i}`,
					null,
					"2026-04-10T13:00:00+01:00", // pre-canonical
					"2026-04-10T12:00:00Z", // pre-canonical
					null,
					"active",
				);
				insertMsg.run(
					id,
					`m-${id}`,
					"2026-04-10T13:00:00+01:00",
					"outgoing",
					"default",
					"hello",
					0,
					null,
					null,
					1,
				);
			}

			// Reset all backfill markers so the next reopen starts fresh.
			const wipe = db.prepare("DELETE FROM schema_meta WHERE key = ?");
			wipe.run("canonicalize_timestamps_backfill");
			wipe.run("canonicalize_timestamps_backfill_phase");
			wipe.run("canonicalize_timestamps_backfill_cursor");

			// Simulate a CRASH partway through the conversations phase
			// by pre-seeding the cursor to "conv-05". A clean reopen
			// should resume from conv-05+1 and finish the remaining
			// conversations BEFORE moving on to messages.
			db.prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?)").run(
				"canonicalize_timestamps_backfill_phase",
				"conversations",
			);
			db.prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?)").run(
				"canonicalize_timestamps_backfill_cursor",
				"conv-05",
			);

			// Manually canonicalize conv-00..conv-05 to mirror what a
			// successful pre-crash partial run would have done. Leave
			// conv-06..conv-11 in pre-canonical form so we can verify
			// the resume processed them.
			const updateConv = db.prepare(
				"UPDATE conversations SET started_at = ?, last_message_at = ? WHERE conversation_id = ?",
			);
			for (let i = 0; i <= 5; i += 1) {
				const id = `conv-${String(i).padStart(2, "0")}`;
				updateConv.run("2026-04-10T12:00:00.000Z", "2026-04-10T12:00:00.000Z", id);
			}

			logger.close();

			// Reopen — backfill resumes from cursor "conv-05" and
			// processes the remaining 6 conversations + all 12 messages.
			const reopened = new SqliteConversationLogger(dataDir);

			// All 12 conversations are now canonical, including
			// conv-06..conv-11 which the resumed backfill processed.
			const all = await reopened.listConversations();
			expect(all).toHaveLength(12);
			for (const c of all) {
				expect(c.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
				expect(c.lastMessageAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
				for (const m of c.messages) {
					expect(m.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
				}
			}

			// The legacy completion marker is now set so future opens
			// short-circuit at the top of runCanonicalizeBackfillIfNeeded.
			const marker = (
				reopened.database
					.prepare("SELECT value FROM schema_meta WHERE key = ?")
					.get("canonicalize_timestamps_backfill") as { value: string } | undefined
			)?.value;
			expect(marker).toBe("1");

			reopened.close();
		});
	});
});
