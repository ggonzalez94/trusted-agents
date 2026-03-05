import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const KEYFILE_NAME = "agent.key";

export async function generateKeyfile(dataDir: string): Promise<{ path: string; address: string }> {
	const keyDir = join(dataDir, "identity");
	await mkdir(keyDir, { recursive: true });

	const keyPath = join(keyDir, KEYFILE_NAME);
	const privateKey = generatePrivateKey();

	// Store without 0x prefix
	const hex = privateKey.slice(2);
	await writeFile(keyPath, hex, { mode: 0o600 });

	const account = privateKeyToAccount(privateKey);
	return { path: keyPath, address: account.address };
}

export async function importKeyfile(
	dataDir: string,
	privateKeyInput: string,
): Promise<{ path: string; address: string }> {
	const keyDir = join(dataDir, "identity");
	await mkdir(keyDir, { recursive: true });

	// Normalize: accept with or without 0x prefix
	const hex = privateKeyInput.startsWith("0x") ? privateKeyInput.slice(2) : privateKeyInput;
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error("Invalid private key: expected 64-char hex string");
	}

	const keyPath = join(keyDir, KEYFILE_NAME);
	await writeFile(keyPath, hex, { mode: 0o600 });

	const account = privateKeyToAccount(`0x${hex}`);
	return { path: keyPath, address: account.address };
}

export async function loadKeyfile(dataDir: string): Promise<`0x${string}`> {
	const keyPath = join(dataDir, "identity", KEYFILE_NAME);
	const hex = (await readFile(keyPath, "utf-8")).trim();

	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(`Invalid keyfile at ${keyPath}: expected 64-char hex`);
	}

	return `0x${hex}`;
}

export function keyfilePath(dataDir: string): string {
	return join(dataDir, "identity", KEYFILE_NAME);
}
