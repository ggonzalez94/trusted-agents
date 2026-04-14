import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStaticAsset } from "../../src/http/static-assets.js";

describe("resolveStaticAsset", () => {
	let assetsRoot: string;

	beforeEach(async () => {
		assetsRoot = await mkdtemp(join(tmpdir(), "tapd-assets-"));
		await writeFile(join(assetsRoot, "index.html"), "<html></html>");
		await mkdir(join(assetsRoot, "_next", "static", "css"), { recursive: true });
		await writeFile(join(assetsRoot, "_next", "static", "css", "app.css"), "body{}");
		await mkdir(join(assetsRoot, "subdir"), { recursive: true });
		await writeFile(join(assetsRoot, "subdir", "index.html"), "sub");
	});

	afterEach(async () => {
		await rm(assetsRoot, { recursive: true, force: true });
	});

	it("resolves the index when the path is /", async () => {
		const result = await resolveStaticAsset(assetsRoot, "/");
		expect(result?.contentType).toBe("text/html; charset=utf-8");
		expect(result?.body.toString("utf-8")).toBe("<html></html>");
	});

	it("resolves nested asset paths", async () => {
		const result = await resolveStaticAsset(
			assetsRoot,
			"/_next/static/css/app.css",
		);
		expect(result?.contentType).toBe("text/css; charset=utf-8");
		expect(result?.body.toString("utf-8")).toBe("body{}");
	});

	it("falls back to index.html for directories", async () => {
		const result = await resolveStaticAsset(assetsRoot, "/subdir");
		expect(result?.body.toString("utf-8")).toBe("sub");
	});

	it("returns null for non-existent files", async () => {
		const result = await resolveStaticAsset(assetsRoot, "/missing.html");
		expect(result).toBeNull();
	});

	it("rejects path traversal attempts", async () => {
		const result = await resolveStaticAsset(assetsRoot, "/../etc/passwd");
		expect(result).toBeNull();
	});

	it("rejects null bytes in path", async () => {
		const result = await resolveStaticAsset(assetsRoot, "/index.html\u0000");
		expect(result).toBeNull();
	});

	it("returns application/octet-stream for unknown extensions", async () => {
		await writeFile(join(assetsRoot, "data.bin"), "x");
		const result = await resolveStaticAsset(assetsRoot, "/data.bin");
		expect(result?.contentType).toBe("application/octet-stream");
	});
});
