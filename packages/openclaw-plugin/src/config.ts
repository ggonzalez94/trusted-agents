import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import { readTrimmedString } from "./input.js";

/**
 * Plugin config for the thin OpenClaw TAP plugin. Both fields are optional —
 * when omitted, the underlying client falls back to the standard tap data dir
 * (`~/.trustedagents`) and `<dataDir>/.tapd.sock`.
 */
export interface TapOpenClawPluginConfig {
	/** TAP data directory. Defaults to `~/.trustedagents`. */
	dataDir?: string;
	/** Override path to tapd's Unix socket. Defaults to `<dataDir>/.tapd.sock`. */
	tapdSocketPath?: string;
}

const UI_HINTS = {
	dataDir: {
		label: "TAP Data Dir",
		help: "Path to the TAP data directory tapd is running against. Defaults to ~/.trustedagents.",
	},
	tapdSocketPath: {
		label: "tapd Socket Path",
		help: "Override path to tapd's Unix socket. Defaults to <dataDir>/.tapd.sock.",
		advanced: true,
	},
};

const JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		dataDir: { type: "string" },
		tapdSocketPath: { type: "string" },
	},
} as const;

export const tapOpenClawPluginConfigSchema: OpenClawPluginConfigSchema = {
	parse: parseTapOpenClawPluginConfig,
	jsonSchema: JSON_SCHEMA,
	uiHints: UI_HINTS,
};

export function parseTapOpenClawPluginConfig(raw: unknown): TapOpenClawPluginConfig {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("TAP plugin config must be an object");
	}
	const input = raw as { dataDir?: unknown; tapdSocketPath?: unknown };
	const result: TapOpenClawPluginConfig = {};
	const dataDir = parseOptionalTrimmedString(input.dataDir, "dataDir");
	if (dataDir !== undefined) result.dataDir = dataDir;
	const tapdSocketPath = parseOptionalTrimmedString(input.tapdSocketPath, "tapdSocketPath");
	if (tapdSocketPath !== undefined) result.tapdSocketPath = tapdSocketPath;
	return result;
}

function parseOptionalTrimmedString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = readTrimmedString(value);
	if (trimmed === undefined) {
		throw new Error(`TAP plugin config.${field} must be a non-empty string`);
	}
	return trimmed;
}
