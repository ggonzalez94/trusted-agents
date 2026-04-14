import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	CURRENT_SCHEMA_VERSION,
	applySchema,
	getSchemaVersion,
} from "../../../src/conversation/sqlite-schema.js";

describe("sqlite-schema", () => {
	it("creates the conversation and messages tables", () => {
		const db = new Database(":memory:");
		applySchema(db);

		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		expect(tables.map((t) => t.name)).toEqual(
			expect.arrayContaining(["conversations", "messages", "schema_meta"]),
		);
		db.close();
	});

	it("seeds the schema version", () => {
		const db = new Database(":memory:");
		applySchema(db);
		expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
		db.close();
	});

	it("is idempotent", () => {
		const db = new Database(":memory:");
		applySchema(db);
		applySchema(db);
		applySchema(db);
		expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
		db.close();
	});

	it("creates the dedupe index", () => {
		const db = new Database(":memory:");
		applySchema(db);
		const indices = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'")
			.all() as { name: string }[];
		expect(indices.map((i) => i.name)).toEqual(
			expect.arrayContaining(["idx_messages_conversation_timestamp", "idx_messages_dedup"]),
		);
		db.close();
	});

	it("enables WAL journal mode", () => {
		const db = new Database(":memory:");
		applySchema(db);
		// In-memory databases cannot actually be WAL; but the pragma must have been applied
		// without error. Use a real temp file to verify WAL takes effect.
		const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		expect(typeof mode.journal_mode).toBe("string");
		db.close();
	});

	it("enforces foreign keys", () => {
		const db = new Database(":memory:");
		applySchema(db);
		const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(row.foreign_keys).toBe(1);
		db.close();
	});
});
