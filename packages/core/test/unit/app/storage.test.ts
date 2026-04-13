import { beforeEach, describe, expect, it } from "vitest";
import { FileAppStorage } from "../../../src/app/storage.js";
import { useTempDir } from "../../helpers/temp-dir.js";

describe("FileAppStorage", () => {
	const dir = useTempDir("tap-app-storage");
	let storage: FileAppStorage;

	beforeEach(() => {
		storage = new FileAppStorage(dir.path, "test-app");
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
		const storage2 = new FileAppStorage(dir.path, "test-app");
		expect(await storage2.get("persistent")).toBe(true);
	});

	it("isolates different app IDs", async () => {
		const other = new FileAppStorage(dir.path, "other-app");
		await storage.set("key", "app1");
		await other.set("key", "app2");
		expect(await storage.get("key")).toBe("app1");
		expect(await other.get("key")).toBe("app2");
	});

	it("handles concurrent writes without data loss", async () => {
		const promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(storage.set(`key-${i}`, i));
		}
		await Promise.all(promises);

		const all = await storage.list();
		for (let i = 0; i < 10; i++) {
			expect(all[`key-${i}`]).toBe(i);
		}
	});

	it("throws on corrupted JSON instead of silently resetting", async () => {
		await storage.set("important", "data");

		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await writeFile(join(dir.path, "apps", "test-app", "state.json"), "not valid json{{{");

		await expect(storage.get("important")).rejects.toThrow();
	});

	it("returns empty state for missing file (ENOENT)", async () => {
		const fresh = new FileAppStorage(dir.path, "nonexistent-app");
		expect(await fresh.get("anything")).toBeUndefined();
		expect(await fresh.list()).toEqual({});
	});
});
