import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { http, createPublicClient, formatUnits, parseAbi } from "viem";
import { runCli } from "../helpers/run-cli.js";

// ── Chain & USDC Config ──────────────────────────────────────────────────────

interface ChainE2EConfig {
	caip2: string;
	alias: string;
	rpcUrl: string;
	usdcAddress: `0x${string}`;
	usdcDecimals: number;
}

export const CHAIN_CONFIGS: Record<string, ChainE2EConfig> = {
	base: {
		caip2: "eip155:8453",
		alias: "base",
		rpcUrl: "https://mainnet.base.org",
		usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		usdcDecimals: 6,
	},
	taiko: {
		caip2: "eip155:167000",
		alias: "taiko",
		rpcUrl: "https://rpc.mainnet.taiko.xyz",
		usdcAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
		usdcDecimals: 6,
	},
};

// ── ERC20 ABI (balanceOf only) ───────────────────────────────────────────────

const ERC20_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

// ── Balance Helpers ──────────────────────────────────────────────────────────

export async function getUsdcBalance(address: `0x${string}`, chainKey: string): Promise<bigint> {
	const config = CHAIN_CONFIGS[chainKey];
	if (!config) {
		throw new Error(
			`Unknown chain key: ${chainKey}. Valid keys: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
		);
	}

	const client = createPublicClient({
		transport: http(config.rpcUrl),
	});

	return client.readContract({
		address: config.usdcAddress,
		abi: ERC20_ABI,
		functionName: "balanceOf",
		args: [address],
	});
}

export function formatUsdc(balance: bigint, chainKey: string): string {
	const config = CHAIN_CONFIGS[chainKey];
	if (!config) {
		throw new Error(
			`Unknown chain key: ${chainKey}. Valid keys: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
		);
	}
	return formatUnits(balance, config.usdcDecimals);
}

export async function waitForBalanceChange(opts: {
	address: `0x${string}`;
	chainKey: string;
	previousBalance: bigint;
	description: string;
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<bigint> {
	const {
		address,
		chainKey,
		previousBalance,
		description,
		timeoutMs = 30_000,
		intervalMs = 3_000,
	} = opts;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const current = await getUsdcBalance(address, chainKey);
		if (current !== previousBalance) {
			return current;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new Error(
		`Timed out waiting for balance change (${description}). ` +
			`Address: ${address}, chain: ${chainKey}, previous balance: ${previousBalance}`,
	);
}

// ── CLI Output Parsing ───────────────────────────────────────────────────────

export function parseJsonOutput(stdout: string): { ok: boolean; data: unknown } {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.includes('"ok"')) {
			continue;
		}
		return JSON.parse(trimmed) as { ok: boolean; data: unknown };
	}
	throw new Error(`No JSON envelope found in output:\n${stdout}`);
}

interface AgentBalanceSnapshot {
	messagingAddress: `0x${string}`;
	executionAddress: `0x${string}`;
	fundingAddress: `0x${string}`;
	messagingUsdcBalance: bigint;
	executionUsdcBalance: bigint;
	fundingUsdcBalance: bigint;
}

function parseRequiredAddress(value: unknown, label: string): `0x${string}` {
	if (typeof value !== "string" || !value.startsWith("0x")) {
		throw new Error(`Invalid ${label} in balance output`);
	}
	return value as `0x${string}`;
}

function parseRequiredBigInt(value: unknown, label: string): bigint {
	if (typeof value !== "string" || !/^\d+$/u.test(value)) {
		throw new Error(`Invalid ${label} in balance output`);
	}
	return BigInt(value);
}

function parseAgentBalanceSnapshotData(data: unknown): AgentBalanceSnapshot {
	if (typeof data !== "object" || data === null) {
		throw new Error("Invalid balance output payload");
	}

	const payload = data as Record<string, unknown>;
	const messagingAddress = parseRequiredAddress(payload.messaging_address, "messaging_address");
	const executionAddress = parseRequiredAddress(payload.execution_address, "execution_address");
	const fundingAddress = parseRequiredAddress(payload.funding_address, "funding_address");
	const messagingUsdcBalance = parseRequiredBigInt(
		payload.messaging_usdc_balance_raw,
		"messaging_usdc_balance_raw",
	);
	const executionUsdcBalance = parseRequiredBigInt(
		payload.execution_usdc_balance_raw,
		"execution_usdc_balance_raw",
	);

	let fundingUsdcBalance: bigint;
	if (fundingAddress.toLowerCase() === messagingAddress.toLowerCase()) {
		fundingUsdcBalance = messagingUsdcBalance;
	} else if (fundingAddress.toLowerCase() === executionAddress.toLowerCase()) {
		fundingUsdcBalance = executionUsdcBalance;
	} else {
		throw new Error(
			`Funding address ${fundingAddress} did not match messaging/execution addresses in balance output`,
		);
	}

	return {
		messagingAddress,
		executionAddress,
		fundingAddress,
		messagingUsdcBalance,
		executionUsdcBalance,
		fundingUsdcBalance,
	};
}

export async function readAgentBalanceSnapshot(
	dataDir: string,
	chain?: string,
): Promise<AgentBalanceSnapshot> {
	const args = ["--json", "--data-dir", dataDir, "balance"];
	if (chain) {
		args.push(chain);
	}

	const result = await runCli(args);
	if (result.exitCode !== 0) {
		throw new Error(
			`balance failed (exit ${result.exitCode}).\n` +
				`stdout: ${result.stdout}\n` +
				`stderr: ${result.stderr}`,
		);
	}

	const parsed = parseJsonOutput(result.stdout);
	return parseAgentBalanceSnapshotData(parsed.data);
}

// ── Sync Polling ─────────────────────────────────────────────────────────────

export async function waitForSync(opts: {
	dataDir: string;
	description: string;
	timeoutMs?: number;
	intervalMs?: number;
	/** Require at least this many messages processed. Defaults to 1. Set to 0 to accept empty syncs. */
	minProcessed?: number;
}): Promise<void> {
	const { dataDir, description, timeoutMs = 30_000, intervalMs = 2_000, minProcessed = 1 } = opts;
	const deadline = Date.now() + timeoutMs;

	let lastStdout = "";
	let lastStderr = "";
	let lastProcessed = 0;

	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
		lastStdout = result.stdout;
		lastStderr = result.stderr;

		if (result.exitCode === 0) {
			// Parse the sync report to check processed count
			try {
				const parsed = parseJsonOutput(result.stdout);
				const data = parsed.data as { processed?: number };
				lastProcessed = data.processed ?? 0;
				if (lastProcessed >= minProcessed) {
					return;
				}
			} catch {
				// If we can't parse, keep polling
			}
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new Error(
		`Timed out waiting for sync (${description}).\n` +
			`Expected at least ${minProcessed} processed, last saw ${lastProcessed}.\n` +
			`Last stdout: ${lastStdout}\n` +
			`Last stderr: ${lastStderr}`,
	);
}

/**
 * Poll sync + contacts until a peer appears as an active contact.
 * Combines message sync (to process pending XMTP messages) with contact checks.
 */
export async function waitForContact(opts: {
	dataDir: string;
	peerName: string;
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<void> {
	const { dataDir, peerName, timeoutMs = 60_000, intervalMs = 2_000 } = opts;
	const deadline = Date.now() + timeoutMs;
	let lastSyncExitCode = 0;
	let lastSyncStdout = "";
	let lastSyncStderr = "";

	while (Date.now() < deadline) {
		// Sync to process any pending messages
		const syncResult = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
		lastSyncExitCode = syncResult.exitCode;
		lastSyncStdout = syncResult.stdout;
		lastSyncStderr = syncResult.stderr;

		// Check contacts
		const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
		if (result.exitCode === 0) {
			try {
				const parsed = parseJsonOutput(result.stdout);
				const data = parsed.data as {
					contacts: Array<{ name: string; status: string }>;
				};
				const contact = data.contacts.find((c) => c.name === peerName);
				if (syncResult.exitCode === 0 && contact?.status === "active") return;
			} catch {
				// parse error, keep polling
			}
		}

		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Final check with detailed error
	const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
	let found = "[]";
	try {
		const parsed = parseJsonOutput(result.stdout);
		const data = parsed.data as { contacts: Array<{ name: string; status: string }> };
		found = data.contacts.map((c) => `${c.name}(${c.status})`).join(", ");
	} catch {
		// ignore
	}

	throw new Error(
		`Timed out waiting for contact "${peerName}" to become active (${timeoutMs}ms). ` +
			`DataDir: ${dataDir}. Found: [${found}]. ` +
			`Last sync exit: ${lastSyncExitCode}. ` +
			`Last sync stdout: ${lastSyncStdout}. ` +
			`Last sync stderr: ${lastSyncStderr}`,
	);
}

// ── Grant File Helpers ───────────────────────────────────────────────────────

export async function writeGrantFile(
	dir: string,
	filename: string,
	grants: unknown[],
): Promise<string> {
	const filePath = join(dir, filename);
	const content = { version: "tap-grants/v1", grants };
	await writeFile(filePath, JSON.stringify(content, null, 2), "utf-8");
	return filePath;
}

// ── Permissions Helpers ──────────────────────────────────────────────────────

export interface PermissionSnapshot {
	granted_by_me: { grants: Array<{ grantId: string; status: string }> };
	granted_by_peer: { grants: Array<{ grantId: string; status: string }> };
}

export async function waitForPermissions(
	dataDir: string,
	peer: string,
	predicate: (snapshot: PermissionSnapshot) => boolean,
	timeoutMs = 30_000,
	intervalMs = 2_000,
): Promise<PermissionSnapshot> {
	const deadline = Date.now() + timeoutMs;

	let lastStdout = "";
	let lastStderr = "";
	let lastSnapshot: PermissionSnapshot | undefined;

	while (Date.now() < deadline) {
		// Sync first so any pending messages are processed
		await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);

		const result = await runCli(["--json", "--data-dir", dataDir, "permissions", "show", peer]);
		lastStdout = result.stdout;
		lastStderr = result.stderr;

		if (result.exitCode === 0) {
			const data = (JSON.parse(result.stdout) as { data: PermissionSnapshot }).data;
			lastSnapshot = data;
			if (predicate(data)) {
				return data;
			}
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new Error(
		`Timed out waiting for permissions for peer "${peer}" (dataDir=${dataDir}).\n` +
			`Last snapshot: ${JSON.stringify(lastSnapshot ?? null)}\n` +
			`Last stdout: ${lastStdout}\n` +
			`Last stderr: ${lastStderr}`,
	);
}

// ── Env Helpers ──────────────────────────────────────────────────────────────

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(`Required environment variable "${name}" is not set`);
	}
	return value;
}
