import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityShowCommand } from "../src/commands/identity-show.js";
import * as configLoader from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { buildMockExecutionPreview, buildTestConfig } from "./helpers/config-fixtures.js";

const { ADDRESS, mockOwsProvider } = vi.hoisted(() => {
	const addr = "0x0DeB8dFf035e7711f72fCde996D01f41bE4C883B" as const;
	return {
		ADDRESS: addr,
		mockOwsProvider: vi.fn().mockImplementation(() => ({
			getAddress: vi.fn().mockResolvedValue(addr),
			signMessage: vi.fn(),
			signTypedData: vi.fn(),
			signTransaction: vi.fn(),
			signAuthorization: vi.fn(),
		})),
	};
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: mockOwsProvider,
	};
});

describe("tap identity show", () => {
	let tempRoot: string;
	const { stdout: stdoutWrites } = useCapturedOutput();

	const config = buildTestConfig();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-identity-show-"));
		process.exitCode = undefined;

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(config);
		vi.spyOn(core, "getExecutionPreview").mockResolvedValue(buildMockExecutionPreview(ADDRESS));
	});

	afterEach(async () => {
		process.exitCode = undefined;
		vi.clearAllMocks();
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("works before registration and shows the execution funding address", async () => {
		await identityShowCommand({ json: true });

		expect(configLoader.loadConfig).toHaveBeenCalledWith({ json: true }, { requireAgentId: false });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.agent_id).toBe(-1);
		expect(output.data?.execution_mode).toBe("eip7702");
		expect(output.data?.execution_address).toBe(ADDRESS);
		expect(output.data?.funding_address).toBe(ADDRESS);
	});

	it("shows a migration hint instead of an opaque OWS error for legacy raw-key agents", async () => {
		const dataDir = join(tempRoot, "legacy-agent");
		await mkdir(join(dataDir, "identity"), { recursive: true });
		await writeFile(
			join(dataDir, "identity", "agent.key"),
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			"utf-8",
		);

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue({
			...config,
			agentId: 11,
			dataDir,
			ows: { wallet: "", apiKey: "" },
		});

		await identityShowCommand({ json: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.message).toContain("tap migrate-wallet");
		expect(mockOwsProvider).not.toHaveBeenCalled();
	});
});
