import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAppStorage } from "../../../src/app/storage.js";

describe("FileAppStorage", () => {
	let tmpDir: string;
	let storage: FileAppStorage;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-app-storage-"));
		storage = new FileAppStorage(tmpDir, "test-app");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined for missing keys", async () => {
		expect(await storage.get("missing")).toBeUndefined();
	});

	it("sets and gets a value", async () => {
		await storage.set("foo", { bar: 42 });
		expect(await storage.get("foo")).toEqual({ bar: 42 });
	});

	it("overwrites existing values", async () => {
		await storage.set("foo", 1);
		await storage.set("foo", 2);
		expect(await storage.get("foo")).toBe(2);
	});

	it("deletes a value", async () => {
		await storage.set("foo", "bar");
		await storage.delete("foo");
		expect(await storage.get("foo")).toBeUndefined();
	});

	it("lists all keys", async () => {
		await storage.set("a", 1);
		await storage.set("b", 2);
		await storage.set("c", 3);
		const all = await storage.list();
		expect(all).toEqual({ a: 1, b: 2, c: 3 });
	});

	it("lists keys with prefix filter", async () => {
		await storage.set("bet/1", { id: 1 });
		await storage.set("bet/2", { id: 2 });
		await storage.set("other", "x");
		const bets = await storage.list("bet/");
		expect(bets).toEqual({ "bet/1": { id: 1 }, "bet/2": { id: 2 } });
	});

	it("persists across instances", async () => {
		await storage.set("persistent", true);
		const storage2 = new FileAppStorage(tmpDir, "test-app");
		expect(await storage2.get("persistent")).toBe(true);
	});

	it("isolates different app IDs", async () => {
		const other = new FileAppStorage(tmpDir, "other-app");
		await storage.set("key", "app1");
		await other.set("key", "app2");
		expect(await storage.get("key")).toBe("app1");
		expect(await other.get("key")).toBe("app2");
	});
});
