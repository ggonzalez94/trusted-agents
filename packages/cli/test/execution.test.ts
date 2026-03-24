import type { TrustedAgentsConfig } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensureExecutionReady,
	executeContractCalls,
	getExecutionPreview,
} from "../src/lib/execution.js";

const { coreEnsureExecutionReady, coreExecuteContractCalls, coreGetExecutionPreview } = vi.hoisted(
	() => ({
		coreEnsureExecutionReady: vi.fn(),
		coreExecuteContractCalls: vi.fn(),
		coreGetExecutionPreview: vi.fn(),
	}),
);

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		ensureExecutionReady: coreEnsureExecutionReady,
		executeContractCalls: coreExecuteContractCalls,
		getExecutionPreview: coreGetExecutionPreview,
	};
});

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11" as const;

const config = {
	agentId: 1,
	chain: "eip155:84532",
	account: privateKeyToAccount(PRIVATE_KEY),
	wallet: { provider: "env-private-key" },
	dataDir: "/tmp/tap",
	chains: {
		"eip155:84532": {
			name: "Base Sepolia",
			caip2: "eip155:84532",
			chainId: 84532,
			rpcUrl: "https://example.test/base-sepolia",
			registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
		},
	},
	inviteExpirySeconds: 3600,
	resolveCacheTtlMs: 60000,
	resolveCacheMaxEntries: 100,
	xmtpEnv: "dev",
	xmtpDbEncryptionKey: undefined,
} satisfies TrustedAgentsConfig;

afterEach(() => {
	vi.clearAllMocks();
});

describe("cli execution wrappers", () => {
	it("delegates getExecutionPreview to core", async () => {
		const expected = {
			requestedMode: "eip7702",
			mode: "eip7702",
			messagingAddress: "0x0000000000000000000000000000000000000001",
			executionAddress: "0x0000000000000000000000000000000000000001",
			fundingAddress: "0x0000000000000000000000000000000000000001",
			paymasterProvider: "circle",
			warnings: [],
		};
		coreGetExecutionPreview.mockResolvedValue(expected);

		await expect(getExecutionPreview(config, config.chains[config.chain]!)).resolves.toEqual(
			expected,
		);
		expect(coreGetExecutionPreview).toHaveBeenCalledWith(
			config,
			config.chains[config.chain]!,
			undefined,
		);
	});

	it("delegates ensureExecutionReady and executeContractCalls to core", async () => {
		coreEnsureExecutionReady.mockResolvedValue(undefined);
		coreExecuteContractCalls.mockResolvedValue({
			requestedMode: "eip7702",
			mode: "eip7702",
			messagingAddress: "0x0000000000000000000000000000000000000001",
			executionAddress: "0x0000000000000000000000000000000000000001",
			fundingAddress: "0x0000000000000000000000000000000000000001",
			paymasterProvider: "circle",
			warnings: [],
			gasPaymentMode: "erc20-usdc",
			transactionReceipt: {
				transactionHash: "0xabc",
				logs: [],
			},
			transactionHash: "0xabc",
			userOperationHash: "0xdef",
		});

		await ensureExecutionReady(config, config.chains[config.chain]!, {
			preview: { requestedMode: "eip7702", mode: "eip7702" },
		});
		await expect(
			executeContractCalls(
				config,
				config.chains[config.chain]!,
				[{ to: "0x0000000000000000000000000000000000000002", data: "0x" }],
				{ preview: { requestedMode: "eip7702", mode: "eip7702" } },
			),
		).resolves.toMatchObject({
			transactionHash: "0xabc",
			userOperationHash: "0xdef",
		});

		expect(coreEnsureExecutionReady).toHaveBeenCalledWith(config, config.chains[config.chain]!, {
			preview: { requestedMode: "eip7702", mode: "eip7702" },
		});
		expect(coreExecuteContractCalls).toHaveBeenCalledWith(
			config,
			config.chains[config.chain]!,
			[{ to: "0x0000000000000000000000000000000000000002", data: "0x" }],
			{ preview: { requestedMode: "eip7702", mode: "eip7702" } },
		);
	});
});
