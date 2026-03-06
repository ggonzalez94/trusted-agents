import {
	http,
	type Address,
	createPublicClient,
	createWalletClient,
	formatEther,
	isAddress,
	parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

interface SendSpec {
	address: Address;
	amount: string;
}

interface ThresholdSpec {
	address: Address;
	targetBalance: string;
	buffer: string;
}

async function main(): Promise<void> {
	const { sends, thresholds } = parseArgs(process.argv.slice(2));
	if (sends.length === 0 && thresholds.length === 0) {
		printUsageAndExit("At least one --send or --if-below target is required.");
	}

	const rawKey = process.env.TAP_SMOKE_TREASURY_PRIVATE_KEY;
	if (!rawKey) {
		printUsageAndExit("Missing TAP_SMOKE_TREASURY_PRIVATE_KEY.");
	}

	const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
	const account = privateKeyToAccount(privateKey);
	const transport = http(baseSepolia.rpcUrls.default.http[0]);
	const publicClient = createPublicClient({ chain: baseSepolia, transport });
	const walletClient = createWalletClient({ account, chain: baseSepolia, transport });

	for (const spec of thresholds) {
		const currentBalance = await publicClient.getBalance({ address: spec.address });
		console.log(
			`threshold-check ${spec.address} balance=${formatEther(currentBalance)} target=${spec.targetBalance}`,
		);
		const targetBalance = parseEther(spec.targetBalance);
		if (currentBalance >= targetBalance) {
			console.log(`skip ${spec.address} threshold satisfied`);
			continue;
		}
		const amount = targetBalance - currentBalance + parseEther(spec.buffer);
		await sendEth(walletClient, publicClient, spec.address, amount);
	}

	for (const spec of sends) {
		await sendEth(walletClient, publicClient, spec.address, parseEther(spec.amount));
	}

	const treasuryBalance = await publicClient.getBalance({ address: account.address });
	console.log(`treasury ${account.address} balance=${formatEther(treasuryBalance)}`);
}

async function sendEth(
	walletClient: ReturnType<typeof createWalletClient>,
	publicClient: ReturnType<typeof createPublicClient>,
	address: Address,
	amount: bigint,
): Promise<void> {
	const hash = await walletClient.sendTransaction({
		account: walletClient.account!,
		to: address,
		value: amount,
		chain: walletClient.chain,
	});
	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	console.log(`sent ${formatEther(amount)} ETH to ${address} tx=${hash} status=${receipt.status}`);
}

function parseArgs(argv: string[]): {
	sends: SendSpec[];
	thresholds: ThresholdSpec[];
} {
	const sends: SendSpec[] = [];
	const thresholds: ThresholdSpec[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const value = argv[index + 1];
		if (!value) {
			printUsageAndExit(`Missing value for ${token}.`);
		}

		if (token === "--send") {
			sends.push(parseSendSpec(value));
			index += 1;
			continue;
		}

		if (token === "--ensure" || token === "--if-below") {
			thresholds.push(parseThresholdSpec(value));
			index += 1;
			continue;
		}

		printUsageAndExit(`Unknown argument: ${token}`);
	}

	return { sends, thresholds };
}

function parseSendSpec(value: string): SendSpec {
	const [address, amount] = value.split(":");
	if (!address || !amount || !isAddress(address)) {
		printUsageAndExit(`Invalid --send value: ${value}`);
	}
	return { address, amount };
}

function parseThresholdSpec(value: string): ThresholdSpec {
	const [address, targetBalance, buffer = "0"] = value.split(":");
	if (!address || !targetBalance || !isAddress(address)) {
		printUsageAndExit(`Invalid --ensure value: ${value}`);
	}
	return { address, targetBalance, buffer };
}

function printUsageAndExit(message: string): never {
	console.error(message);
	console.error("Usage:");
	console.error(
		"  bun packages/cli/scripts/live-smoke-top-up.ts --ensure <address:targetBalanceEth[:bufferEth]> [--ensure ...]",
	);
	console.error(
		"  bun packages/cli/scripts/live-smoke-top-up.ts --send <address:amountEth> [--send ...]",
	);
	process.exit(1);
}

await main();
