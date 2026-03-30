import type { SigningProvider, TrustedAgentsConfig } from "trusted-agents-core";
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

const config = {
	agentId: 1,
	chain: "eip155:8453",
	ows: { wallet: "test-wallet", passphrase: "test-passphrase" },
	dataDir: "/tmp/tap",
	chains: {
		"eip155:8453": {
			name: "Base",
			caip2: "eip155:8453",
			chainId: 8453,
			rpcUrl: "https://example.test/base",
			registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
		},
	},
	inviteExpirySeconds: 3600,
	resolveCacheTtlMs: 60000,
	resolveCacheMaxEntries: 100,
	xmtpDbEncryptionKey: undefined,
} satisfies TrustedAgentsConfig;

const fakeProvider: SigningProvider = {
	getAddress: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000001"),
	signMessage: vi.fn(),
	signTypedData: vi.fn(),
	signTransaction: vi.fn(),
	signAuthorization: vi.fn(),
};

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

		await expect(
			getExecutionPreview(config, config.chains[config.chain]!, fakeProvider),
		).resolves.toEqual(expected);
		expect(coreGetExecutionPreview).toHaveBeenCalledWith(
			config,
			config.chains[config.chain]!,
			fakeProvider,
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

		await ensureExecutionReady(config, config.chains[config.chain]!, fakeProvider, {
			preview: { requestedMode: "eip7702", mode: "eip7702" },
		});
		await expect(
			executeContractCalls(
				config,
				config.chains[config.chain]!,
				fakeProvider,
				[{ to: "0x0000000000000000000000000000000000000002", data: "0x" }],
				{ preview: { requestedMode: "eip7702", mode: "eip7702" } },
			),
		).resolves.toMatchObject({
			transactionHash: "0xabc",
			userOperationHash: "0xdef",
		});

		expect(coreEnsureExecutionReady).toHaveBeenCalledWith(
			config,
			config.chains[config.chain]!,
			fakeProvider,
			{
				preview: { requestedMode: "eip7702", mode: "eip7702" },
			},
		);
		expect(coreExecuteContractCalls).toHaveBeenCalledWith(
			config,
			config.chains[config.chain]!,
			fakeProvider,
			[{ to: "0x0000000000000000000000000000000000000002", data: "0x" }],
			{ preview: { requestedMode: "eip7702", mode: "eip7702" } },
		);
	});
});
