import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PluginPackageJson = {
	main?: string;
	files?: string[];
	openclaw?: {
		extensions?: string[];
	};
};

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const packageJsonPath = resolve(packageDir, "package.json");

describe("published OpenClaw plugin metadata", () => {
	it("points OpenClaw at the built entrypoint and ships only compiled runtime files", () => {
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PluginPackageJson;

		expect(manifest.main).toBe("./dist/index.js");
		expect(manifest.openclaw?.extensions).toEqual(["./dist/index.js"]);
		expect(manifest.files).toEqual(
			expect.arrayContaining(["dist", "skills", "openclaw.plugin.json"]),
		);
		expect(manifest.files).not.toContain("index.ts");
	});
});
