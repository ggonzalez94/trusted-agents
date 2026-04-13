import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS_DIR = join(MODULE_DIR, "../../skills/trusted-agents");
const PACKAGED_ASSET_SKILLS_DIR = join(MODULE_DIR, "../../assets/skills/trusted-agents");
const REPO_SKILLS_DIR = join(MODULE_DIR, "../../../../skills/trusted-agents");

export function resolveTapSkillsSourcePath(): string {
	const candidates = getTapSkillSourceCandidates();

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "SKILL.md"))) {
			return candidate;
		}
	}

	throw new Error(
		`Bundled TAP skills were not found. Checked: ${candidates.join(", ") || "(none provided)"}`,
	);
}

function getTapSkillSourceCandidates(): string[] {
	const override = process.env.TAP_SKILLS_SOURCE?.trim();
	return [override, PACKAGED_SKILLS_DIR, PACKAGED_ASSET_SKILLS_DIR, REPO_SKILLS_DIR].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
}
