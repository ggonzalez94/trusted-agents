import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const releaseChannelScriptPath = join(repoRoot, "scripts", "release-channel.mjs");

describe("scripts/release-channel.mjs", () => {
	it("treats stable versions as latest-channel releases", async () => {
		const result = await runReleaseChannel("0.1.5");

		expect(result).toEqual({
			version: "0.1.5",
			isPrerelease: false,
			npmDistTag: null,
		});
	});

	it("maps beta prereleases to the beta dist-tag", async () => {
		const result = await runReleaseChannel("0.2.0-beta.1");

		expect(result).toEqual({
			version: "0.2.0-beta.1",
			isPrerelease: true,
			npmDistTag: "beta",
		});
	});

	it("maps rc prereleases to the beta dist-tag", async () => {
		const result = await runReleaseChannel("0.2.0-rc.1");

		expect(result).toEqual({
			version: "0.2.0-rc.1",
			isPrerelease: true,
			npmDistTag: "beta",
		});
	});
});

async function runReleaseChannel(version: string): Promise<{
	version: string;
	isPrerelease: boolean;
	npmDistTag: string | null;
}> {
	const { stdout } = await execFileAsync("node", [releaseChannelScriptPath, version], {
		cwd: repoRoot,
		env: process.env,
	});
	return JSON.parse(stdout) as {
		version: string;
		isPrerelease: boolean;
		npmDistTag: string | null;
	};
}
