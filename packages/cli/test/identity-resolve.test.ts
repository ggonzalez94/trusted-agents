import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityResolveSelfCommand } from "../src/commands/identity-resolve.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as contextLib from "../src/lib/context.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { buildTestConfig } from "./helpers/config-fixtures.js";

describe("identity resolve", () => {
	const { stdout: stdoutWrites } = useCapturedOutput();

	beforeEach(() => {
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("resolves self using config.agentId and the requested chain", async () => {
		const config = buildTestConfig({ agentId: 42 });
		const resolve = vi.fn().mockResolvedValue({
			agentId: 42,
			chain: "eip155:1",
			ownerAddress: "0x1111111111111111111111111111111111111111",
			agentAddress: "0x2222222222222222222222222222222222222222",
			xmtpEndpoint: "0x2222222222222222222222222222222222222222",
			registrationFile: {
				name: "Self Agent",
				description: "Resolved self",
			},
			capabilities: ["chat"],
			resolvedAt: "2026-03-05T00:00:00.000Z",
		});

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(config);
		vi.spyOn(contextLib, "buildContext").mockReturnValue({
			config,
			trustStore: {} as never,
			resolver: { resolve } as never,
		});

		await identityResolveSelfCommand({ json: true }, "eip155:1");

		expect(resolve).toHaveBeenCalledWith(42, "eip155:1");
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { agent_id?: number; chain?: string };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.agent_id).toBe(42);
		expect(output.data?.chain).toBe("eip155:1");
	});
});
