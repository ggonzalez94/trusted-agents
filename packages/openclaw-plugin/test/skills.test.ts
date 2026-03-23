import { existsSync, readFileSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const skillDir = resolve(repoRoot, "skills/trusted-agents");
const skillPath = resolve(skillDir, "SKILL.md");

describe("TAP skill bundle", () => {
	it("keeps every referenced file inside the skill tree", () => {
		const markdown = readFileSync(skillPath, "utf-8");
		const references = [...markdown.matchAll(/references\/[a-zA-Z0-9_-]+\.md/g)].map(
			(match) => match[0],
		);
		const unique = [...new Set(references)];

		expect(unique.length).toBeGreaterThan(0);
		for (const reference of unique) {
			const resolvedPath = resolve(skillDir, reference);
			expect(normalize(resolvedPath).startsWith(normalize(`${skillDir}/`))).toBe(true);
			expect(existsSync(resolvedPath)).toBe(true);
		}
	});
});
