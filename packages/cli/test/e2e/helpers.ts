import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { http, createPublicClient, formatUnits, parseAbi } from "viem";
import { runCli } from "../helpers/run-cli.js";

// ── Chain & USDC Config ──────────────────────────────────────────────────────

export interface ChainE2EConfig {
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

// ── Sync Polling ─────────────────────────────────────────────────────────────

export async function waitForSync(opts: {
	dataDir: string;
	description: string;
	timeoutMs?: number;
	intervalMs?: number;
	expectPattern?: RegExp | string;
}): Promise<void> {
	const { dataDir, description, timeoutMs = 30_000, intervalMs = 2_000, expectPattern } = opts;
	const deadline = Date.now() + timeoutMs;

	let lastStdout = "";
	let lastStderr = "";

	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
		lastStdout = result.stdout;
		lastStderr = result.stderr;

		if (result.exitCode === 0) {
			if (expectPattern === undefined) {
				return;
			}
			const combined = result.stdout + result.stderr;
			const matches =
				typeof expectPattern === "string"
					? combined.includes(expectPattern)
					: expectPattern.test(combined);
			if (matches) {
				return;
			}
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new Error(
		`Timed out waiting for sync (${description}).\n` +
			`Last stdout: ${lastStdout}\n` +
			`Last stderr: ${lastStderr}`,
	);
}

// ── Contact Assertions ───────────────────────────────────────────────────────

export async function assertContactActive(dataDir: string, peerName: string): Promise<void> {
	const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
	if (result.exitCode !== 0) {
		throw new Error(
			`contacts list failed (exit ${result.exitCode}).\n` +
				`stdout: ${result.stdout}\n` +
				`stderr: ${result.stderr}`,
		);
	}

	const parsed = JSON.parse(result.stdout) as {
		data: {
			contacts: Array<{ name: string; status: string }>;
		};
	};

	const contact = parsed.data.contacts.find((c) => c.name === peerName);
	if (!contact) {
		const names = parsed.data.contacts.map((c) => c.name).join(", ");
		throw new Error(
			`Contact "${peerName}" not found in contacts for dataDir=${dataDir}. Found: [${names}]`,
		);
	}

	if (contact.status !== "active") {
		throw new Error(
			`Contact "${peerName}" has status "${contact.status}", expected "active" (dataDir=${dataDir})`,
		);
	}
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

	while (Date.now() < deadline) {
		// Sync to process any pending messages
		await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);

		// Check contacts
		const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
		if (result.exitCode === 0) {
			try {
				const parsed = parseJsonOutput(result.stdout);
				const data = parsed.data as {
					contacts: Array<{ name: string; status: string }>;
				};
				const contact = data.contacts.find((c) => c.name === peerName);
				if (contact?.status === "active") return;
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
			`DataDir: ${dataDir}. Found: [${found}]`,
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

// ── Config Helpers ───────────────────────────────────────────────────────────

export async function readAgentAddress(dataDir: string): Promise<`0x${string}`> {
	const result = await runCli(["--json", "--data-dir", dataDir, "identity", "show"]);
	if (result.exitCode !== 0) {
		throw new Error(
			`identity show failed (exit ${result.exitCode}).\n` +
				`stdout: ${result.stdout}\n` +
				`stderr: ${result.stderr}`,
		);
	}

	const parsed = JSON.parse(result.stdout) as {
		data: { address: string };
	};

	return parsed.data.address as `0x${string}`;
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
