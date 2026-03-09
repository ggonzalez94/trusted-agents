import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));

describe("scripts/install.sh", () => {
	let tempRoot: string;
	let homeDir: string;
	let sourceDir: string;
	let binDir: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-install-script-"));
		homeDir = join(tempRoot, "home");
		sourceDir = join(tempRoot, "custom-source");
		binDir = join(tempRoot, "bin");

		await mkdir(homeDir, { recursive: true });
		await mkdir(binDir, { recursive: true });
		await mkdir(join(sourceDir, "packages", "cli", "dist"), { recursive: true });
		await mkdir(join(sourceDir, "packages", "sdk", "skills", "trusted-agents"), {
			recursive: true,
		});
		await writeFile(join(sourceDir, "packages", "cli", "dist", "bin.js"), "#!/usr/bin/env node\n");

		await symlink(join(sourceDir, "packages", "cli", "dist", "bin.js"), join(binDir, "tap"));

		for (const runtime of ["claude", "codex", "openclaw"]) {
			const skillsDir = join(homeDir, `.${runtime}`, "skills");
			await mkdir(skillsDir, { recursive: true });
			await symlink(
				join(sourceDir, "packages", "sdk", "skills", "trusted-agents"),
				join(skillsDir, "trusted-agents"),
			);
		}
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("uninstalls TAP-managed binary and skill symlinks", async () => {
		await execFileAsync("bash", [scriptPath, "--uninstall"], {
			env: {
				...process.env,
				HOME: homeDir,
				TAP_SOURCE_DIR: sourceDir,
				TAP_BIN_DIR: binDir,
			},
		});

		await expect(pathMissing(join(binDir, "tap"))).resolves.toBe(true);
		await expect(pathMissing(join(homeDir, ".claude", "skills", "trusted-agents"))).resolves.toBe(
			true,
		);
		await expect(pathMissing(join(homeDir, ".codex", "skills", "trusted-agents"))).resolves.toBe(
			true,
		);
		await expect(pathMissing(join(homeDir, ".openclaw", "skills", "trusted-agents"))).resolves.toBe(
			true,
		);
	});
});

async function pathMissing(path: string): Promise<boolean> {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}
