import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { writeFileAtomic } from "../lib/atomic-write.js";
import { resolveChainAlias } from "../lib/chains.js";
import {
	resolveConfigPath,
	resolveDataDir,
	validateConfigPathInDataDir,
} from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

const CONFIG_KEY_SEGMENT_ALIASES: Record<string, string> = {
	agentId: "agent_id",
	dbEncryptionKey: "db_encryption_key",
	inviteExpirySeconds: "invite_expiry_seconds",
	paymasterProvider: "paymaster_provider",
	registryAddress: "registry_address",
	rpcUrl: "rpc_url",
	tackApiUrl: "tack_api_url",
};

const NUMERIC_CONFIG_PATHS = new Set([
	"agent_id",
	"invite_expiry_seconds",
	"resolve_cache_ttl_ms",
	"resolve_cache_max_entries",
]);

function normalizeConfigPath(key: string): string[] {
	return key.split(".").map((part) => CONFIG_KEY_SEGMENT_ALIASES[part] ?? part);
}

function parseConfigValue(path: string[], value: string): number | string {
	if (!NUMERIC_CONFIG_PATHS.has(path.join("."))) {
		return value;
	}

	const numericValue = Number(value);
	if (!Number.isFinite(numericValue)) {
		throw new Error(`Expected a numeric value for ${path.join(".")}`);
	}
	return numericValue;
}

export async function configSetCommand(
	key: string,
	value: string,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const configPath = resolveConfigPath(opts, dataDir);
		validateConfigPathInDataDir(opts, configPath, dataDir);

		if (!existsSync(configPath)) {
			throw new Error(`Config file not found at ${configPath}. Run 'tap init' first.`);
		}

		const content = await readFile(configPath, "utf-8");
		const yaml = (YAML.parse(content) as Record<string, unknown>) ?? {};

		// Handle nested keys like xmtp.db_encryption_key
		const parts = normalizeConfigPath(key);
		let target: Record<string, unknown> = yaml;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i]!;
			if (typeof target[part] !== "object" || target[part] === null) {
				target[part] = {};
			}
			target = target[part] as Record<string, unknown>;
		}

		const leafKey = parts[parts.length - 1]!;

		// Resolve chain aliases when setting the chain key
		const resolvedValue = leafKey === "chain" ? resolveChainAlias(value) : value;
		target[leafKey] = parseConfigValue(parts, resolvedValue);

		await writeFileAtomic(configPath, YAML.stringify(yaml));

		success({ key, value: target[leafKey], path: configPath }, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
