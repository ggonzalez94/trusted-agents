import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { GlobalOptions } from "../types.js";
import { writeFileAtomic } from "./atomic-write.js";
import { resolveConfigPath, resolveDataDir, validateConfigPathInDataDir } from "./config-loader.js";

export interface ExpensesConfig {
	serverUrl: string;
	settlementAddress?: `0x${string}`;
	apiToken?: string;
}

interface StoredExpensesYaml {
	expenses?: {
		server_url?: string;
		settlement_address?: string;
		api_token?: string;
	};
}

export async function readExpensesConfig(opts: GlobalOptions): Promise<ExpensesConfig> {
	const envServerUrl = process.env.TAP_EXPENSES_SERVER_URL;
	const envSettlementAddress = process.env.TAP_EXPENSES_SETTLEMENT_ADDRESS;
	const envApiToken = process.env.TAP_EXPENSES_API_TOKEN;
	const dataDir = resolveDataDir(opts);
	const configPath = resolveConfigPath(opts, dataDir);
	validateConfigPathInDataDir(opts, configPath, dataDir);
	const yaml = await readStoredYaml(configPath);
	const serverUrl = envServerUrl ?? yaml.expenses?.server_url;
	if (serverUrl === undefined) {
		throw new Error("Expense server URL is not configured. Run: tap expenses setup --server <url>");
	}
	const settlementAddress = envSettlementAddress ?? yaml.expenses?.settlement_address;
	const apiToken = envApiToken ?? yaml.expenses?.api_token;
	return {
		serverUrl: normalizeExpensesServerUrl(serverUrl),
		...(settlementAddress
			? { settlementAddress: normalizeExpenseSettlementAddress(settlementAddress) }
			: {}),
		...(apiToken ? { apiToken: normalizeExpenseApiToken(apiToken) } : {}),
	};
}

export async function writeExpensesConfig(
	opts: GlobalOptions,
	config: ExpensesConfig,
): Promise<{ path: string }> {
	const dataDir = resolveDataDir(opts);
	const configPath = resolveConfigPath(opts, dataDir);
	validateConfigPathInDataDir(opts, configPath, dataDir);
	if (!existsSync(configPath)) {
		throw new Error(`Config file not found at ${configPath}. Run 'tap init' first.`);
	}
	const yaml = (YAML.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>) ?? {};
	const expenses = typeof yaml.expenses === "object" && yaml.expenses !== null ? yaml.expenses : {};
	yaml.expenses = {
		...(expenses as Record<string, unknown>),
		server_url: normalizeExpensesServerUrl(config.serverUrl),
		...(config.settlementAddress
			? { settlement_address: normalizeExpenseSettlementAddress(config.settlementAddress) }
			: {}),
		...(config.apiToken ? { api_token: normalizeExpenseApiToken(config.apiToken) } : {}),
	};
	await writeFileAtomic(configPath, YAML.stringify(yaml));
	return { path: configPath };
}

export function normalizeExpensesServerUrl(value: string): string {
	const parsed = new URL(value);
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error("Expense server URL must use http or https");
	}
	return parsed.toString().replace(/\/$/, "");
}

export function normalizeExpenseSettlementAddress(value: string): `0x${string}` {
	if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
		throw new Error(`Invalid settlement address: ${value}`);
	}
	return value as `0x${string}`;
}

export function normalizeExpenseApiToken(value: string): string {
	const token = value.trim();
	if (token.length < 8) {
		throw new Error("Expense API token must be at least 8 characters");
	}
	return token;
}

async function readStoredYaml(configPath: string): Promise<StoredExpensesYaml> {
	if (!existsSync(configPath)) {
		return {};
	}
	return (YAML.parse(await readFile(configPath, "utf-8")) as StoredExpensesYaml) ?? {};
}
