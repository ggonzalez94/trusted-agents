import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTapHermesAssets } from "../src/hermes/install.js";

describe("Hermes asset install", () => {
	let tempRoot: string;
	let hermesHome: string;
	let skillsSourceDir: string;
	let originalSkillsSource: string | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-hermes-install-"));
		hermesHome = join(tempRoot, "hermes-home");
		skillsSourceDir = join(tempRoot, "skills", "trusted-agents");
		await mkdir(skillsSourceDir, { recursive: true });
		originalSkillsSource = process.env.TAP_SKILLS_SOURCE;
	});

	afterEach(async () => {
		if (originalSkillsSource === undefined) {
			process.env.TAP_SKILLS_SOURCE = undefined;
		} else {
			process.env.TAP_SKILLS_SOURCE = originalSkillsSource;
		}
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("prefers TAP_SKILLS_SOURCE when copying Hermes skill assets", async () => {
		process.env.TAP_SKILLS_SOURCE = skillsSourceDir;
		await writeFile(
			join(skillsSourceDir, "SKILL.md"),
			"---\nname: trusted-agents\ndescription: Override skill\n---\n\n# Override Skill\n",
			"utf-8",
		);

		await installTapHermesAssets(hermesHome);

		await expect(
			readFile(join(hermesHome, "skills", "trusted-agents", "SKILL.md"), "utf-8"),
		).resolves.toContain("# Override Skill");
	});
});
