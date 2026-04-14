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

		// Runtime metadata that's NEWER must be preserved (no rollback).
		// The merge picks MAX(legacy.lastMessageAt, runtime.lastMessageAt) =
		// runtime, and MAX(last_read_at) = runtime.
		expect(afterRetry.lastMessageAt).toBe("2026-04-10T12:00:00.000Z");
		expect(afterRetry.lastReadAt).toBe("2026-04-10T12:00:05.000Z");

		// Legacy metadata that ADDS missing context fills the gaps:
		//   - Topic is COALESCE(runtime, legacy). Runtime never set a
		//     topic, so the legacy topic now backfills the row.
		//   - startedAt is MIN(legacy.startedAt, runtime.startedAt) = legacy.
		//     The conversation actually started on 2026-04-01 per legacy
		//     even though the runtime row was created later from a fresh
		//     append. The MIN merge restores that earlier start.
		expect(afterRetry.topic).toBe("stale topic");
		expect(afterRetry.startedAt).toBe("2026-04-01T00:00:00.000Z");

		// Legacy messages are still inserted via the replay + dedupe path.
		// The runtime message AND both legacy messages must coexist.
		expect(afterRetry.messages.find((m) => m.messageId === "runtime-1")).toBeDefined();
		expect(afterRetry.messages.find((m) => m.messageId === "legacy-1")).toBeDefined();
		expect(afterRetry.messages.find((m) => m.messageId === "legacy-2")).toBeDefined();

		// Messages come back sorted by (timestamp ASC, insert_order ASC).
		// Legacy messages have timestamps older than the runtime message,
		// so they come first in the timeline regardless of insert order.
		expect(afterRetry.messages.map((m) => m.messageId)).toEqual([
			"legacy-1", // 2026-04-01T00:00:00 — legacy, oldest
			"legacy-2", // 2026-04-01T00:01:00 — legacy
			"runtime-1", // 2026-04-10T12:00:00 — runtime, newest
		]);

		logger.close();
	});

	it("repairs canonical metadata on a pre-fix partial-import row when a fixed retry runs", async () => {
		// Upgrade-path coverage: a pre-residual-2 install could have
		// landed a conversation row plus some messages with placeholder
		// metadata (started_at = first replayed message ts, last_read_at
		// = NULL, status = 'active') because the OLD migration code
		// used logMessage() in a per-message transaction loop. After
		// upgrading to the residual-fix code, importLog must REPAIR
		// that placeholder metadata when the legacy file is retried,
		// not skip the UPDATE and leave the conversation permanently
		// stale.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const conversationId = "conv-upgrade-path";

		const canonical = {
			conversationId,
			connectionId: "conn-1",
			peerAgentId: 21,
			peerDisplayName: "Bob",
			topic: "Project sync",
			startedAt: "2026-04-01T00:00:00.000Z",
			lastMessageAt: "2026-04-01T00:02:00.000Z",
			lastReadAt: "2026-04-01T00:01:30.000Z",
			status: "completed" as const,
			messages: [
				{
					messageId: "leg-1",
					timestamp: "2026-04-01T00:00:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "first",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{
					messageId: "leg-2",
					timestamp: "2026-04-01T00:01:00.000Z",
					direction: "incoming" as const,
					scope: "default",
					content: "second",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				{
					messageId: "leg-3",
					timestamp: "2026-04-01T00:02:00.000Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "third",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		await writeFile(
			join(dataDir, "conversations", "conv-upgrade-path.json"),
			JSON.stringify(canonical),
		);

		// Step 1: simulate the pre-fix partial state directly. The OLD
		// migration would have inserted the conversation row (via the
		// first replayed message's timestamp) plus the first two
		// messages, then crashed before writing the canonical metadata
		// UPDATE and before marking the file in migrated_files. Here we
		// reproduce that state by calling logMessage twice — which
		// uses the same INSERT path the legacy code did — and asserting
		// the placeholder metadata.
		const logger = new SqliteConversationLogger(dataDir);
		await logger.logMessage(conversationId, canonical.messages[0], {
			connectionId: "conn-1",
			peerAgentId: 21,
			peerDisplayName: "Bob",
		});
		await logger.logMessage(conversationId, canonical.messages[1]);

		const placeholder = await logger.getConversation(conversationId);
		expect(placeholder).not.toBeNull();
		if (!placeholder) return;
		// Confirm we're in the "placeholder" state the upgrade path needs
		// to repair: started_at derived from msg[0], last_message_at from
		// msg[1], topic null, lastReadAt null, status default 'active'.
		expect(placeholder.startedAt).toBe("2026-04-01T00:00:00.000Z");
		expect(placeholder.lastMessageAt).toBe("2026-04-01T00:01:00.000Z");
		expect(placeholder.topic).toBeUndefined();
		expect(placeholder.lastReadAt).toBeUndefined();
		expect(placeholder.status).toBe("active");

		// Step 2: retry the migration. The conversation row already
		// exists from the simulated pre-fix partial state, so the
		// importLog INSERT OR IGNORE returns changes=0. The fix MUST
		// then run the merge UPDATE so the placeholder metadata gets
		// repaired from the legacy log's canonical values.
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);
		expect(report.migrated).toBe(1);

		const repaired = await logger.getConversation(conversationId);
		expect(repaired).not.toBeNull();
		if (!repaired) return;

		// Canonical metadata is now repaired:
		//   - topic: pre-existing was null, legacy is "Project sync" → COALESCE picks legacy
		//   - startedAt: MIN — both are "2026-04-01T00:00:00.000Z" → unchanged
		//   - lastMessageAt: MAX — placeholder had msg[1] ts, legacy has msg[2] ts (later) → legacy
		//   - lastReadAt: placeholder NULL, legacy non-null → legacy
		//   - status: rank('active')=0, rank('completed')=1 → 'completed' wins
		expect(repaired.topic).toBe("Project sync");
		expect(repaired.startedAt).toBe("2026-04-01T00:00:00.000Z");
		expect(repaired.lastMessageAt).toBe("2026-04-01T00:02:00.000Z");
		expect(repaired.lastReadAt).toBe("2026-04-01T00:01:30.000Z");
		expect(repaired.status).toBe("completed");

		// All three legacy messages must be in the DB. The first two
		// were inserted by the simulated pre-fix path; the third gets
		// added by the import replay loop's dedupe-aware insert.
		expect(repaired.messages.map((m) => m.messageId)).toEqual(["leg-1", "leg-2", "leg-3"]);

		logger.close();
	});

	it("merges metadata by temporal instant, not lexical string order, under mixed timestamp precision", async () => {
		// Codex residual: string `<`/`>` does not equal temporal order
		// for ISO 8601 with varying precision or timezone offsets. The
		// classic pitfall is `...00Z` vs `...00.500Z` — the SHORTER
		// string is GREATER lexically (because 'Z' (90) > '.' (46) at
		// position 18) but EARLIER temporally. A naive `>= a ? a : b`
		// merge would let a legacy "00Z" snapshot beat an existing
		// "00.500Z" runtime value, rolling lastMessageAt backward.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const conversationId = "conv-precision";
		const legacy = {
			conversationId,
			connectionId: "conn-1",
			peerAgentId: 31,
			peerDisplayName: "Carla",
			topic: "Mixed precision",
			startedAt: "2026-04-01T00:00:00Z",
			lastMessageAt: "2026-04-10T12:00:00Z",
			lastReadAt: "2026-04-10T12:00:00Z",
			status: "active" as const,
			messages: [
				{
					messageId: "legacy-only",
					timestamp: "2026-04-01T00:00:00Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "older legacy message",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		await writeFile(join(dataDir, "conversations", "conv-precision.json"), JSON.stringify(legacy));

		const logger = new SqliteConversationLogger(dataDir);
		await logger.logMessage(
			conversationId,
			{
				messageId: "runtime-precise",
				timestamp: "2026-04-10T12:00:00.500Z",
				direction: "incoming",
				scope: "default",
				content: "newer runtime message at .5s",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{ connectionId: "conn-1", peerAgentId: 31, peerDisplayName: "Carla" },
		);
		await logger.markRead(conversationId, "2026-04-10T12:00:00.500Z");

		// Sanity check the lexical bug exists in the raw strings — the
		// SHORTER (legacy) string is lexically GREATER even though it
		// represents an EARLIER instant.
		expect("2026-04-10T12:00:00Z" > "2026-04-10T12:00:00.500Z").toBe(true);

		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);
		expect(report.migrated).toBe(1);

		const merged = await logger.getConversation(conversationId);
		expect(merged).not.toBeNull();
		if (!merged) return;

		// MAX(runtime, legacy) by INSTANT — runtime wins because .500Z
		// is 500ms LATER than 00Z. A lexical comparison would have
		// rolled this back to "2026-04-10T12:00:00Z".
		expect(merged.lastMessageAt).toBe("2026-04-10T12:00:00.500Z");
		expect(merged.lastReadAt).toBe("2026-04-10T12:00:00.500Z");

		logger.close();
	});

	it("merges metadata by temporal instant under mixed timezone offsets", async () => {
		// Same root issue as the precision test, but under timezone
		// offset differences. We use a legacy timestamp that is
		// ACTUALLY 1 second earlier than the runtime instant but
		// lexically greater because of the offset notation.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const conversationId = "conv-tz";
		const legacy = {
			conversationId,
			connectionId: "conn-1",
			peerAgentId: 47,
			peerDisplayName: "Dan",
			startedAt: "2026-04-10T13:00:00+01:00", // = noon UTC
			lastMessageAt: "2026-04-10T13:00:00+01:00", // = noon UTC
			lastReadAt: null,
			status: "active" as const,
			messages: [
				{
					messageId: "legacy-tz",
					timestamp: "2026-04-10T13:00:00+01:00",
					direction: "outgoing" as const,
					scope: "default",
					content: "legacy in +01:00",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		await writeFile(join(dataDir, "conversations", "conv-tz.json"), JSON.stringify(legacy));

		const logger = new SqliteConversationLogger(dataDir);
		// Runtime row's timestamp is strictly LATER (1 second after
		// noon UTC) but lexically LESS than `13:00:00+01:00`.
		await logger.logMessage(
			conversationId,
			{
				messageId: "runtime-tz",
				timestamp: "2026-04-10T12:00:01Z",
				direction: "incoming",
				scope: "default",
				content: "runtime 1s after legacy noon",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{ connectionId: "conn-1", peerAgentId: 47, peerDisplayName: "Dan" },
		);

		// Sanity: lexical order says runtime < legacy, but instant
		// order says runtime > legacy.
		expect("2026-04-10T12:00:01Z" < "2026-04-10T13:00:00+01:00").toBe(true);
		expect(Date.parse("2026-04-10T12:00:01Z")).toBeGreaterThan(
			Date.parse("2026-04-10T13:00:00+01:00"),
		);

		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);
		expect(report.migrated).toBe(1);

		const merged = await logger.getConversation(conversationId);
		expect(merged).not.toBeNull();
		if (!merged) return;

		// MAX by INSTANT picks the runtime value, even though it loses
		// a lexical comparison to the legacy offset-form string. The
		// stored value is the CANONICAL 24-char `YYYY-MM-DDTHH:mm:ss.sssZ`
		// form, not the raw input — every write path canonicalizes via
		// `canonicalizeTimestamp` so the SQLite store only ever holds
		// canonical strings and lexical ORDER BY equals instant order.
		expect(merged.lastMessageAt).toBe("2026-04-10T12:00:01.000Z");

		logger.close();
	});

	it("returns messages in true temporal order even after canonicalizing mixed encodings", async () => {
		// Codex residual (medium): even with the merge fixed, the
		// logger still ORDERS messages and conversations by lexical
		// `timestamp` / `last_message_at` columns. The canonicalization
		// fix puts every row in the strict 24-char form, so lexical
		// order must equal instant order. Verify with an import that
		// holds messages in mixed encodings — they should come back
		// in true temporal order, not source order.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const conversationId = "conv-order";
		const log = {
			conversationId,
			connectionId: "conn-1",
			peerAgentId: 81,
			peerDisplayName: "Eve",
			startedAt: "2026-04-10T12:00:00Z",
			lastMessageAt: "2026-04-10T13:00:01+01:00",
			status: "active" as const,
			messages: [
				// (1) noon UTC = 12:00:00Z
				{
					messageId: "m-noon",
					timestamp: "2026-04-10T12:00:00Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "first noon UTC",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				// (3) 1 second after noon UTC, with .500 fraction
				{
					messageId: "m-late",
					timestamp: "2026-04-10T12:00:01.500Z",
					direction: "outgoing" as const,
					scope: "default",
					content: "third late",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
				// (2) noon UTC + 0.5s, expressed in +01:00 offset form.
				// Lexically this is greater than `12:00:01.500Z`
				// because '1' (49) > '0' (48) at position 11. The
				// pre-canonicalization logger would have ordered (3)
				// before (2), wrong. With canonicalization, (2)
				// becomes `2026-04-10T12:00:00.500Z` and (3) stays as
				// `2026-04-10T12:00:01.500Z`, so lexical order matches
				// instant order.
				{
					messageId: "m-mid",
					timestamp: "2026-04-10T13:00:00.500+01:00",
					direction: "incoming" as const,
					scope: "default",
					content: "second mid +01:00",
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		};
		await writeFile(join(dataDir, "conversations", "conv-order.json"), JSON.stringify(log));

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);
		expect(report.migrated).toBe(1);

		const stored = await logger.getConversation(conversationId);
		expect(stored).not.toBeNull();
		if (!stored) return;

		// Messages return in true temporal order (canonicalized)
		// regardless of input order or encoding form.
		expect(stored.messages.map((m) => m.messageId)).toEqual(["m-noon", "m-mid", "m-late"]);
		// Every stored timestamp is in the canonical 24-char form.
		for (const m of stored.messages) {
			expect(m.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		}

		logger.close();
	});

	it("returns conversation list in true temporal order even after canonicalizing mixed encodings", async () => {
		// Companion to the message-ordering test: list conversations
		// must also use lexical-on-canonical ordering, which the
		// canonicalization invariant guarantees matches instant order.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		const seedLog = (id: string, lastMessageAt: string, content: string) => ({
			conversationId: id,
			connectionId: `conn-${id}`,
			peerAgentId: id.charCodeAt(0),
			peerDisplayName: id,
			startedAt: "2026-04-10T00:00:00Z",
			lastMessageAt,
			status: "active" as const,
			messages: [
				{
					messageId: `${id}-1`,
					timestamp: lastMessageAt,
					direction: "outgoing" as const,
					scope: "default",
					content,
					humanApprovalRequired: false,
					humanApprovalGiven: null,
				},
			],
		});

		// Three conversations with mixed-encoding lastMessageAt that
		// would sort in the WRONG order lexically:
		//   (a) 2026-04-10T13:00:00+01:00 = noon UTC
		//   (b) 2026-04-10T12:00:00.500Z   = noon UTC + 500ms
		//   (c) 2026-04-10T12:00:01Z       = noon UTC + 1s
		// Lexical order on raw strings would put (b) before (c) before
		// (a), which is wrong (a is earliest). Canonicalized, all
		// three become Z-form milliseconds and lexical = instant order.
		await writeFile(
			join(dataDir, "conversations", "conv-a.json"),
			JSON.stringify(seedLog("a", "2026-04-10T13:00:00+01:00", "earliest")),
		);
		await writeFile(
			join(dataDir, "conversations", "conv-b.json"),
			JSON.stringify(seedLog("b", "2026-04-10T12:00:00.500Z", "middle")),
		);
		await writeFile(
			join(dataDir, "conversations", "conv-c.json"),
			JSON.stringify(seedLog("c", "2026-04-10T12:00:01Z", "latest")),
		);

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toEqual([]);
		expect(report.migrated).toBe(3);

		const list = await logger.listConversations();
		// `listConversations` orders by `last_message_at DESC`, so
		// latest first: c (12:00:01Z) > b (12:00:00.500Z) > a (noon).
		expect(list.map((c) => c.conversationId)).toEqual(["c", "b", "a"]);

		logger.close();
	});

	it("rejects legacy logs with non-parseable top-level timestamps", async () => {
		// The merge depends on Date.parse succeeding on both sides.
		// validateConversationLogForImport rejects non-parseable
		// top-level timestamps so the merge never silently picks a
		// NaN side.
		await mkdir(join(dataDir, "conversations"), { recursive: true });
		await writeFile(
			join(dataDir, "conversations", "conv-bad-ts.json"),
			JSON.stringify({
				conversationId: "conv-bad-ts",
				connectionId: "conn-1",
				peerAgentId: 1,
				peerDisplayName: "X",
				startedAt: "not a real timestamp",
				lastMessageAt: "2026-04-01T00:00:00Z",
				status: "active",
				messages: [],
			}),
		);

		const logger = new SqliteConversationLogger(dataDir);
		const report = await migrateFileLogsToSqlite(dataDir, logger);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0].file).toBe("conv-bad-ts.json");
		expect(report.errors[0].error).toMatch(/startedAt/);
		expect(report.migrated).toBe(0);
		expect(await logger.getConversation("conv-bad-ts")).toBeNull();

		logger.close();
	});
});
