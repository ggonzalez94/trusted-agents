import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationLogger } from "../../../src/conversation/sqlite-logger.js";
import { migrateFileLogsToSqlite } from "../../../src/conversation/sqlite-migration.js";

describe("sqlite migration", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "sqlite-mig-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("imports an existing conversation JSON file", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "conv-1.json"),
			JSON.stringify({
				conversationId: "conv-1",
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:01:00.000Z",
				status: "active",
				messages: [
					{
						messageId: "m1",
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "first",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
					{
						messageId: "m2",
						timestamp: "2026-04-01T00:01:00.000Z",
						direction: "incoming",
						scope: "default",
						content: "second",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.migrated).toBe(1);
		expect(report.skipped).toBe(0);
		expect(report.errors).toEqual([]);

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(2);
		expect(log?.peerDisplayName).toBe("Alice");
		expect(log?.messages.map((m) => m.content)).toEqual(["first", "second"]);
		logger.close();
	});

	it("preserves topic and lastReadAt through migration", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "conv-1.json"),
			JSON.stringify({
				conversationId: "conv-1",
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
				topic: "Project kickoff",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				lastReadAt: "2026-04-01T00:05:00.000Z",
				status: "active",
				messages: [
					{
						messageId: "m1",
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "kickoff",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		await migrateFileLogsToSqlite(dataDir, logger);

		const log = await logger.getConversation("conv-1");
		expect(log?.topic).toBe("Project kickoff");
		expect(log?.lastReadAt).toBe("2026-04-01T00:05:00.000Z");
		logger.close();
	});

	it("migrates empty conversations (no messages)", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "empty.json"),
			JSON.stringify({
				conversationId: "empty-1",
				connectionId: "conn-1",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.migrated).toBe(1);

		const log = await logger.getConversation("empty-1");
		expect(log).not.toBeNull();
		expect(log?.messages).toEqual([]);
		logger.close();
	});

	it("moves the conversations directory to conversations.bak after success", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "conv-1.json"),
			JSON.stringify({
				conversationId: "conv-1",
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [
					{
						messageId: "m1",
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "x",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		await migrateFileLogsToSqlite(dataDir, logger);

		const entries = (await readdir(dataDir)).filter((e) => e.startsWith("conversations"));
		expect(entries).toContain("conversations.bak");
		expect(entries).not.toContain("conversations");
		logger.close();
	});

	it("is a no-op on second run", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "conv-1.json"),
			JSON.stringify({
				conversationId: "conv-1",
				connectionId: "conn-1",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		await migrateFileLogsToSqlite(dataDir, logger);
		const second = await migrateFileLogsToSqlite(dataDir, logger);
		expect(second.migrated).toBe(0);
		expect(second.skipped).toBe(0);
		expect(second.errors).toEqual([]);
		logger.close();
	});

	it("does nothing when no conversations directory exists", async () => {
		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.migrated).toBe(0);
		expect(report.errors).toEqual([]);
		logger.close();
	});

	it("collects errors for invalid files but continues", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "valid.json"),
			JSON.stringify({
				conversationId: "valid",
				connectionId: "c",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [
					{
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "x",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);
		await writeFile(join(dataDir, "conversations", "broken.json"), "{not json");

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.migrated).toBe(1);
		expect(report.errors.length).toBeGreaterThanOrEqual(1);
		expect(report.errors[0]?.file).toBe("broken.json");

		const log = await logger.getConversation("valid");
		expect(log).not.toBeNull();
		logger.close();
	});

	it("rejects files missing required fields", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "bad.json"),
			JSON.stringify({ conversationId: "bad" }),
		);

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]?.error).toMatch(/missing required fields/i);
		logger.close();
	});

	it("skips non-json files silently", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(join(dataDir, "conversations", "README.txt"), "ignored");

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.skipped).toBe(1);
		expect(report.errors).toEqual([]);
		logger.close();
	});

	// Finding Fv2.1: migration must stay incomplete when any file fails so
	// the next run gets a chance to retry. Before the fix, a single bad file
	// would still set the flag and rename the directory to a backup,
	// permanently losing the unimported rows.
	it("stays incomplete when a single file fails to import", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "valid.json"),
			JSON.stringify({
				conversationId: "valid",
				connectionId: "c",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [
					{
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "ok",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);
		await writeFile(join(dataDir, "conversations", "broken.json"), "{not json");

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);

		expect(report.errors.length).toBe(1);
		expect(report.errors[0]?.file).toBe("broken.json");

		// The valid file was imported.
		const valid = await logger.getConversation("valid");
		expect(valid?.messages).toHaveLength(1);

		// conversations/ is still in place (NOT renamed to conversations.bak).
		const entries = (await readdir(dataDir)).filter((e) => e.startsWith("conversations"));
		expect(entries).toContain("conversations");
		expect(entries).not.toContain("conversations.bak");

		// The migration flag MUST NOT be set.
		const flag = logger.database
			.prepare("SELECT value FROM schema_meta WHERE key = 'conversation_logs_migrated_at'")
			.get() as { value: string } | undefined;
		expect(flag).toBeUndefined();

		logger.close();
	});

	it("retries on next run and succeeds after the bad file is removed", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "valid.json"),
			JSON.stringify({
				conversationId: "valid",
				connectionId: "c",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [
					{
						messageId: "m1",
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "ok",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);
		await writeFile(join(dataDir, "conversations", "broken.json"), "{not json");

		const logger = new SqliteConversationLogger(dataDir);
		const first = await migrateFileLogsToSqlite(dataDir, logger);
		expect(first.errors.length).toBe(1);

		// Operator clears the bad file and re-runs.
		await rm(join(dataDir, "conversations", "broken.json"));
		const second = await migrateFileLogsToSqlite(dataDir, logger);
		expect(second.errors).toEqual([]);

		// Directory was renamed to backup this time.
		const entries = (await readdir(dataDir)).filter((e) => e.startsWith("conversations"));
		expect(entries).toContain("conversations.bak");
		expect(entries).not.toContain("conversations");

		// Flag is now set.
		const flag = logger.database
			.prepare("SELECT value FROM schema_meta WHERE key = 'conversation_logs_migrated_at'")
			.get() as { value: string } | undefined;
		expect(flag).toBeDefined();

		// The single valid row is still present (SQLite dedup on re-import).
		const valid = await logger.getConversation("valid");
		expect(valid?.messages).toHaveLength(1);

		logger.close();
	});

	it("sets the flag and renames to backup when every file is valid", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "conv-1.json"),
			JSON.stringify({
				conversationId: "conv-1",
				connectionId: "conn-1",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);

		const entries = (await readdir(dataDir)).filter((e) => e.startsWith("conversations"));
		expect(entries).toContain("conversations.bak");
		expect(entries).not.toContain("conversations");

		const flag = logger.database
			.prepare("SELECT value FROM schema_meta WHERE key = 'conversation_logs_migrated_at'")
			.get() as { value: string } | undefined;
		expect(flag).toBeDefined();

		logger.close();
	});

	// Residual 2: once a file has been imported on a previous run, a
	// retry must NOT replay it. After Fv2.1 the migration correctly
	// fails closed on any file error, but the partial-success path
	// replayed every file including the already-imported ones. If new
	// messages arrived via tapd between the failed and successful
	// attempts, the canonical metadata UPDATE would roll them back to
	// the stale source JSON. Tracking migrated file names in a dedicated
	// table makes the retry skip already-imported files entirely.
	it("retry does not overwrite canonical metadata from previously-imported files", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "good.json"),
			JSON.stringify({
				conversationId: "conv-good",
				connectionId: "conn-1",
				peerAgentId: 1,
				peerDisplayName: "Alice",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [
					{
						messageId: "m1",
						timestamp: "2026-04-01T00:00:00.000Z",
						direction: "outgoing",
						scope: "default",
						content: "hello from legacy",
						humanApprovalRequired: false,
						humanApprovalGiven: null,
					},
				],
			}),
		);
		await writeFile(join(dataDir, "conversations", "bad.json"), "{not json");

		const logger = new SqliteConversationLogger(dataDir);
		const first = await migrateFileLogsToSqlite(dataDir, logger);
		expect(first.errors.length).toBe(1);
		expect(first.errors[0]?.file).toBe("bad.json");
		expect(first.migrated).toBe(1);

		// Simulate new runtime activity: a message arrives via tapd
		// after the partial-failure run, mutating last_message_at on
		// the already-imported conversation.
		await logger.logMessage("conv-good", {
			messageId: "m2",
			timestamp: "2026-04-01T01:00:00.000Z",
			direction: "incoming",
			scope: "default",
			content: "tapd delivered this after the first attempt",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		});
		const afterRuntime = await logger.getConversation("conv-good");
		expect(afterRuntime?.messages).toHaveLength(2);
		expect(afterRuntime?.lastMessageAt).toBe("2026-04-01T01:00:00.000Z");

		// Fix the bad file so the next run can complete.
		await writeFile(
			join(dataDir, "conversations", "bad.json"),
			JSON.stringify({
				conversationId: "conv-bad",
				connectionId: "conn-2",
				peerAgentId: 2,
				peerDisplayName: "Bob",
				startedAt: "2026-04-01T02:00:00.000Z",
				lastMessageAt: "2026-04-01T02:00:00.000Z",
				status: "active",
				messages: [],
			}),
		);

		const second = await migrateFileLogsToSqlite(dataDir, logger);
		expect(second.errors).toEqual([]);

		// good.json was skipped on the retry because migrated_files
		// already has a row for it. Its canonical metadata is still
		// the post-runtime value, NOT rolled back to the source JSON.
		expect(second.migrated).toBe(1); // only bad.json this time
		const preserved = await logger.getConversation("conv-good");
		expect(preserved?.messages).toHaveLength(2);
		expect(preserved?.lastMessageAt).toBe("2026-04-01T01:00:00.000Z");

		// bad.json is now imported.
		const bad = await logger.getConversation("conv-bad");
		expect(bad).not.toBeNull();

		// The full-success path ran: backup created, global flag set.
		const entries = (await readdir(dataDir)).filter((e) => e.startsWith("conversations"));
		expect(entries).toContain("conversations.bak");
		expect(entries).not.toContain("conversations");
		const flag = logger.database
			.prepare("SELECT value FROM schema_meta WHERE key = 'conversation_logs_migrated_at'")
			.get() as { value: string } | undefined;
		expect(flag).toBeDefined();

		logger.close();
	});

	it("records imported files in the migrated_files table", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "one.json"),
			JSON.stringify({
				conversationId: "conv-one",
				connectionId: "c",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [],
			}),
		);
		await writeFile(join(dataDir, "conversations", "bad.json"), "not json");

		const logger = new SqliteConversationLogger(dataDir);
		await migrateFileLogsToSqlite(dataDir, logger);

		const rows = logger.database
			.prepare("SELECT file_name FROM migrated_files ORDER BY file_name")
			.all() as { file_name: string }[];
		expect(rows.map((r) => r.file_name)).toEqual(["one.json"]);

		logger.close();
	});

	it("transaction atomicity: metadata and migrated_files land together", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "only.json"),
			JSON.stringify({
				conversationId: "conv-only",
				connectionId: "c",
				peerAgentId: 1,
				peerDisplayName: "A",
				startedAt: "2026-04-01T00:00:00.000Z",
				lastMessageAt: "2026-04-01T00:00:00.000Z",
				status: "active",
				messages: [],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);

		// Monkey-patch the prepare layer so the migrated_files insert
		// throws. Because the finalize step is wrapped in
		// db.transaction(), the rollback should undo the metadata
		// UPDATE too, leaving the file eligible for retry with no
		// half-written state.
		const originalPrepare = logger.database.prepare.bind(logger.database);
		let forcedThrow = false;
		(logger.database as { prepare: typeof originalPrepare }).prepare = ((sql: string) => {
			const stmt = originalPrepare(sql);
			if (sql.includes("INSERT OR REPLACE INTO migrated_files")) {
				return {
					...stmt,
					run: (...args: unknown[]) => {
						if (!forcedThrow) {
							forcedThrow = true;
							throw new Error("forced failure before marker insert");
						}
						return stmt.run(...(args as Parameters<typeof stmt.run>));
					},
				} as typeof stmt;
			}
			return stmt;
		}) as typeof originalPrepare;

		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors.length).toBe(1);
		expect(report.errors[0]?.error).toContain("forced failure");

		// The transaction rolled back — no migrated_files row, and the
		// conversation row from the INSERT OR IGNORE is also gone.
		const rows = logger.database.prepare("SELECT file_name FROM migrated_files").all() as {
			file_name: string;
		}[];
		expect(rows).toHaveLength(0);
		const conv = logger.database
			.prepare("SELECT conversation_id FROM conversations WHERE conversation_id = ?")
			.get("conv-only") as { conversation_id: string } | undefined;
		expect(conv).toBeUndefined();

		logger.close();
	});

	// Finding Fv2.2: legacy JSON is not guaranteed to be on-disk ordered
	// (FileConversationLogger sorted on read), so replaying in source order
	// can corrupt timestamps. Status was also hard-coded to "active" by the
	// insert path regardless of the source value.
	it("sorts out-of-order messages before replay and preserves canonical metadata", async () => {
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const canonical = {
			conversationId: "conv-meta",
			connectionId: "conn-1",
			peerAgentId: 7,
			peerDisplayName: "Alice",
			topic: "Roadmap",
			startedAt: "2026-04-01T00:00:00.000Z",
			lastMessageAt: "2026-04-01T00:02:00.000Z",
			lastReadAt: "2026-04-01T00:01:30.000Z",
			status: "completed" as const,
			messages: [
				{
					messageId: "m3",
					timestamp: "2026-04-01T00:02:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "third",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{
					messageId: "m1",
					timestamp: "2026-04-01T00:00:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "first",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{
					messageId: "m2",
					timestamp: "2026-04-01T00:01:00.000Z",
					direction: "incoming" as const,
					scope: "default",
					content: "second",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		await writeFile(join(dataDir, "conversations", "conv-meta.json"), JSON.stringify(canonical));

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);

		const log = await logger.getConversation("conv-meta");
		expect(log).not.toBeNull();
		if (!log) return;

		// Messages come back sorted by (timestamp, insert_order).
		expect(log.messages.map((m) => m.content)).toEqual(["first", "second", "third"]);

		// Canonical metadata is preserved from the source JSON.
		expect(log.startedAt).toBe("2026-04-01T00:00:00.000Z");
		expect(log.lastMessageAt).toBe("2026-04-01T00:02:00.000Z");
		expect(log.lastReadAt).toBe("2026-04-01T00:01:30.000Z");
		expect(log.status).toBe("completed");
		expect(log.topic).toBe("Roadmap");

		logger.close();
	});

	it("rolls back a same-file partial failure so retries cannot overwrite newer runtime activity", async () => {
		// This is the residual-2 continuation: even with per-file tracking,
		// if a single legacy JSON file has a malformed message after some
		// valid ones, the earlier messages must NOT leak into SQLite before
		// the failure. Otherwise, newer runtime activity that lands before
		// the retry could be rolled back when the retry replays the same
		// (still-malformed) file.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const partialLog = {
			conversationId: "conv-partial",
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
			startedAt: "2026-04-01T00:00:00.000Z",
			lastMessageAt: "2026-04-01T00:01:00.000Z",
			status: "active" as const,
			messages: [
				{
					messageId: "legacy-1",
					timestamp: "2026-04-01T00:00:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "valid first legacy message",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{
					messageId: "legacy-2",
					timestamp: "2026-04-01T00:01:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					// Intentionally malformed: content must be a string but
					// this is a number. importLog's pre-validator rejects.
					content: 12345 as unknown as string,
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		await writeFile(
			join(dataDir, "conversations", "conv-partial.json"),
			JSON.stringify(partialLog),
		);

		const logger = new SqliteConversationLogger(dataDir);

		// First attempt: migration rejects the file because message[1]
		// fails validation. Because importLog is all-or-nothing, NOTHING
		// from this file should land in SQLite — not even the valid
		// first message.
		const firstReport = await migrateFileLogsToSqlite(dataDir, logger);
		expect(firstReport.errors).toHaveLength(1);
		expect(firstReport.migrated).toBe(0);
		expect(await logger.getConversation("conv-partial")).toBeNull();

		// Simulate newer runtime activity arriving for the same
		// conversation via the normal append path.
		await logger.logMessage(
			"conv-partial",
			{
				messageId: "runtime-1",
				timestamp: "2026-04-05T12:00:00.000Z",
				direction: "incoming",
				scope: "default",
				content: "runtime message after failed migration",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{ connectionId: "conn-1", peerAgentId: 42, peerDisplayName: "Alice" },
		);

		const afterRuntime = await logger.getConversation("conv-partial");
		expect(afterRuntime).not.toBeNull();
		if (!afterRuntime) return;
		expect(afterRuntime.lastMessageAt).toBe("2026-04-05T12:00:00.000Z");

		// Second migration attempt (still malformed on disk): the file
		// continues to fail validation, NOTHING about conv-partial should
		// change, and the runtime's lastMessageAt must NOT be rolled back.
		const retry = await migrateFileLogsToSqlite(dataDir, logger);
		expect(retry.errors).toHaveLength(1);
		expect(retry.migrated).toBe(0);

		const afterRetry = await logger.getConversation("conv-partial");
		expect(afterRetry).not.toBeNull();
		if (!afterRetry) return;
		expect(afterRetry.lastMessageAt).toBe("2026-04-05T12:00:00.000Z");
		expect(afterRetry.messages.find((m) => m.messageId === "runtime-1")).toBeDefined();
		// The original "valid first legacy message" must NOT be in the DB
		// because the whole-file rollback prevented it.
		expect(afterRetry.messages.find((m) => m.messageId === "legacy-1")).toBeUndefined();

		logger.close();
	});

	it("does not roll back canonical metadata when a fixed legacy file is retried after runtime activity", async () => {
		// Residual 2 tertiary continuation: if a legacy file fails on the
		// first import attempt, runtime activity then lands on that
		// conversation, and the user later fixes the file on disk, the
		// eventual successful retry must NOT restore the legacy JSON's
		// topic/startedAt/lastMessageAt/lastReadAt/status over the newer
		// runtime state.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const conversationId = "conv-eventual";

		// Step 1: seed the legacy file with a malformed message so the
		// first migration attempt rejects it.
		const brokenLog = {
			conversationId,
			connectionId: "conn-1",
			peerAgentId: 17,
			peerDisplayName: "Alice",
			topic: "stale topic",
			startedAt: "2026-04-01T00:00:00.000Z",
			lastMessageAt: "2026-04-01T00:01:00.000Z",
			lastReadAt: "2026-04-01T00:00:30.000Z",
			status: "active" as const,
			messages: [
				{
					messageId: "legacy-1",
					timestamp: "2026-04-01T00:00:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "legacy first",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{
					messageId: "legacy-2",
					timestamp: "2026-04-01T00:01:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: 42 as unknown as string, // malformed: not a string
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		const filePath = join(dataDir, "conversations", "conv-eventual.json");
		await writeFile(filePath, JSON.stringify(brokenLog));

		const logger = new SqliteConversationLogger(dataDir);

		const firstReport = await migrateFileLogsToSqlite(dataDir, logger);
		expect(firstReport.errors).toHaveLength(1);
		expect(firstReport.migrated).toBe(0);
		expect(await logger.getConversation(conversationId)).toBeNull();

		// Step 2: runtime activity lands. A new message arrives via the
		// normal append path. This creates the conversation row with the
		// runtime's authoritative metadata.
		await logger.logMessage(
			conversationId,
			{
				messageId: "runtime-1",
				timestamp: "2026-04-10T12:00:00.000Z",
				direction: "incoming",
				scope: "default",
				content: "runtime message that arrived after the failed migration",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{ connectionId: "conn-1", peerAgentId: 17, peerDisplayName: "Alice" },
		);
		// Mark it read so we can assert lastReadAt is preserved too.
		await logger.markRead(conversationId, "2026-04-10T12:00:05.000Z");

		const runtimeState = await logger.getConversation(conversationId);
		expect(runtimeState).not.toBeNull();
		if (!runtimeState) return;
		expect(runtimeState.lastMessageAt).toBe("2026-04-10T12:00:00.000Z");
		expect(runtimeState.lastReadAt).toBe("2026-04-10T12:00:05.000Z");
		expect(runtimeState.topic).toBeUndefined();

		// Step 3: fix the legacy file on disk (replace the bad message
		// with a valid one). The fixed legacy log has OLDER timestamps
		// than the runtime state.
		const fixedLog = {
			...brokenLog,
			messages: [
				brokenLog.messages[0],
				{
					...brokenLog.messages[1],
					content: "legacy second (fixed)",
				},
			],
		};
		await writeFile(filePath, JSON.stringify(fixedLog));

		// Step 4: retry. The file now validates, so importLog runs
		// successfully. Because the conversation row already exists from
		// the runtime activity in step 2, importLog MUST skip the
		// canonical metadata UPDATE — otherwise it would roll back
		// lastMessageAt from 2026-04-10 to 2026-04-01, lastReadAt from
		// 2026-04-10 to 2026-04-01, and topic from undefined to "stale topic".
		const secondReport = await migrateFileLogsToSqlite(dataDir, logger);
		expect(secondReport.errors).toEqual([]);
		expect(secondReport.migrated).toBe(1);

		const afterRetry = await logger.getConversation(conversationId);
		expect(afterRetry).not.toBeNull();
		if (!afterRetry) return;

		// Runtime metadata must be preserved.
		expect(afterRetry.lastMessageAt).toBe("2026-04-10T12:00:00.000Z");
		expect(afterRetry.lastReadAt).toBe("2026-04-10T12:00:05.000Z");
		// Topic stays undefined (runtime never set it).
		expect(afterRetry.topic).toBeUndefined();
		// startedAt stays at whatever the runtime row holds (the runtime
		// insert used the runtime message timestamp as started_at since
		// the row was freshly created there).
		expect(afterRetry.startedAt).toBe("2026-04-10T12:00:00.000Z");

		// Legacy messages are still inserted via the replay + dedupe path.
		// The runtime message AND both legacy messages must coexist.
		expect(afterRetry.messages.find((m) => m.messageId === "runtime-1")).toBeDefined();
		expect(afterRetry.messages.find((m) => m.messageId === "legacy-1")).toBeDefined();
		expect(afterRetry.messages.find((m) => m.messageId === "legacy-2")).toBeDefined();

		// Messages come back sorted by (timestamp ASC, insert_order ASC).
		// Legacy timestamps are older, runtime is newest.
		expect(afterRetry.messages.map((m) => m.messageId)).toEqual(
			[
				"runtime-1", // 2026-04-10 — inserted first chronologically by runtime
				"legacy-1", // 2026-04-01 — BUT sorted before runtime-1 by timestamp
				"legacy-2", // 2026-04-01 — same timestamp as legacy-1, sort by insert_order
			].sort((a, b) => {
				const tsA = a === "runtime-1" ? "2026-04-10T12:00:00.000Z" : "2026-04-01T00:00:00.000Z";
				const tsB = b === "runtime-1" ? "2026-04-10T12:00:00.000Z" : "2026-04-01T00:00:00.000Z";
				return tsA.localeCompare(tsB);
			}),
		);

		logger.close();
	});
});
