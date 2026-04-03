import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../helpers/run-cli.js";
import { readAgentBalanceSnapshot } from "./helpers.js";

vi.mock("../helpers/run-cli.js", () => ({
	runCli: vi.fn(),
}));

const runCliMock = vi.mocked(runCli);

describe("live E2E balance helpers", () => {
	beforeEach(() => {
		runCliMock.mockReset();
	});

	it("uses the execution account as the funding account when it differs from messaging", async () => {
		runCliMock.mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify({
				status: "ok",
				data: {
					messaging_address: "0x1111111111111111111111111111111111111111",
					execution_address: "0x2222222222222222222222222222222222222222",
					funding_address: "0x2222222222222222222222222222222222222222",
					messaging_usdc_balance_raw: "5000000",
					execution_usdc_balance_raw: "1000000",
				},
			}),
			stderr: "",
		});

		const snapshot = await readAgentBalanceSnapshot("/tmp/agent-a", "taiko");

		expect(runCliMock).toHaveBeenCalledWith([
			"--json",
			"--data-dir",
			"/tmp/agent-a",
			"balance",
			"taiko",
		]);
		expect(snapshot.messagingAddress).toBe("0x1111111111111111111111111111111111111111");
		expect(snapshot.executionAddress).toBe("0x2222222222222222222222222222222222222222");
		expect(snapshot.fundingAddress).toBe("0x2222222222222222222222222222222222222222");
		expect(snapshot.fundingUsdcBalance).toBe(1000000n);
	});

	it("uses the messaging account as the funding account when execution matches messaging", async () => {
		runCliMock.mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify({
				status: "ok",
				data: {
					messaging_address: "0x3333333333333333333333333333333333333333",
					execution_address: "0x3333333333333333333333333333333333333333",
					funding_address: "0x3333333333333333333333333333333333333333",
					messaging_usdc_balance_raw: "7654321",
					execution_usdc_balance_raw: "7654321",
				},
			}),
			stderr: "",
		});

		const snapshot = await readAgentBalanceSnapshot("/tmp/agent-b");

		expect(runCliMock).toHaveBeenCalledWith(["--json", "--data-dir", "/tmp/agent-b", "balance"]);
		expect(snapshot.fundingAddress).toBe("0x3333333333333333333333333333333333333333");
		expect(snapshot.fundingUsdcBalance).toBe(7654321n);
	});
});
