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
});
