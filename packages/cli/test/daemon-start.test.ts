import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFilePath, pidFilePath, portFilePath } from "trusted-agents-tapd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	resolveDataDirMock,
	infoMock,
	successMock,
	errorMock,
	spawnTapdDetachedMock,
	inspectTapdProcessMock,
} = vi.hoisted(() => ({
	resolveDataDirMock: vi.fn(),
	infoMock: vi.fn(),
	successMock: vi.fn(),
	errorMock: vi.fn(),
	spawnTapdDetachedMock: vi.fn(),
	inspectTapdProcessMock: vi.fn(),
}));

vi.mock("../src/lib/config-loader.js", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/config-loader.js")>(
		"../src/lib/config-loader.js",
	);
	return { ...actual, resolveDataDir: resolveDataDirMock };
});

vi.mock("../src/lib/output.js", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/output.js")>("../src/lib/output.js");
	return { ...actual, error: errorMock, info: infoMock, success: successMock };
});

vi.mock("../src/lib/tapd-spawn.js", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/tapd-spawn.js")>(
		"../src/lib/tapd-spawn.js",
	);
	return {
		...actual,
		inspectTapdProcess: inspectTapdProcessMock,
		spawnTapdDetached: spawnTapdDetachedMock,
	};
});

import { daemonStartCommand } from "../src/commands/daemon-start.js";

describe("tap daemon start", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-daemon-start-"));
		resolveDataDirMock.mockReturnValue(dataDir);
		inspectTapdProcessMock.mockResolvedValue({ status: "missing" });
		spawnTapdDetachedMock.mockResolvedValue({
			pid: 4321,
			port: 49999,
			logPath: logFilePath(dataDir),
			pidPath: pidFilePath(dataDir),
		});
	});

	afterEach(async () => {
		vi.clearAllMocks();
		process.exitCode = undefined;
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	it("starts successfully even when a stale port file is left behind", async () => {
		await writeFile(portFilePath(dataDir), "49999", "utf-8");

		await daemonStartCommand({ json: true });

		expect(inspectTapdProcessMock).toHaveBeenCalledWith(dataDir);
		expect(spawnTapdDetachedMock).toHaveBeenCalledWith({ dataDir });
		expect(errorMock).not.toHaveBeenCalled();
		expect(successMock).toHaveBeenCalledOnce();
		expect(process.exitCode).toBeUndefined();
	});
});
