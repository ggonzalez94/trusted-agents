import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillDir = fileURLToPath(new URL("../skills/trusted-agents-openclaw", import.meta.url));
const skillPath = join(skillDir, "SKILL.md");
const sharedReferencePaths = [
	"references/permissions-v1.md",
	"references/permissions-ledger-v1.md",
	"references/capability-map.md",
] as const;

describe("OpenClaw TAP skill bundle", () => {
	it("keeps every referenced file inside the plugin skill tree", () => {
		const markdown = readFileSync(skillPath, "utf-8");
		const referencesSection = markdown.split("## References\n")[1] ?? "";
		const references = referencesSection
			.split("\n")
			.map((line) => line.match(/^- `([^`]+)`$/)?.[1])
			.filter((value): value is string => Boolean(value));

		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) {
			const resolvedPath = resolve(skillDir, reference);
			expect(normalize(resolvedPath).startsWith(normalize(`${skillDir}/`))).toBe(true);
			expect(existsSync(resolvedPath)).toBe(true);
			expect(lstatSync(resolvedPath).isSymbolicLink()).toBe(false);
		}
	});

	it("keeps shared TAP reference docs in sync with the generic TAP skill tree", () => {
		for (const relativePath of sharedReferencePaths) {
			const pluginReference = readFileSync(join(skillDir, relativePath), "utf-8");
			const sdkReference = readFileSync(
				fileURLToPath(new URL(`../../sdk/skills/trusted-agents/${relativePath}`, import.meta.url)),
				"utf-8",
			);
			expect(pluginReference).toBe(sdkReference);
		}
	});
});
