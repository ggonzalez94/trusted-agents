import { resolve } from "node:path";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export interface TapOpenClawIdentityConfig {
	name: string;
	dataDir: string;
	reconcileIntervalMinutes: number;
}

export interface TapOpenClawPluginConfig {
	identities: TapOpenClawIdentityConfig[];
}

const DEFAULT_RECONCILE_INTERVAL_MINUTES = 10;

const UI_HINTS = {
	identities: {
		label: "TAP Identities",
		help: "One or more TAP data directories to run inside Gateway. Each identity gets its own streaming runtime and periodic reconcile loop.",
	},
	"identities[].name": {
		label: "Identity Name",
		help: "Optional stable name used when selecting an identity from the TAP Gateway tool.",
	},
	"identities[].dataDir": {
		label: "TAP Data Dir",
		help: "Path to the TAP data directory created by `tap init`.",
	},
	"identities[].reconcileIntervalMinutes": {
		label: "Reconcile Interval Minutes",
		help: "How often the background TAP runtime should run `syncAll` reconciliation.",
		advanced: true,
	},
};

const JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		identities: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string" },
					dataDir: { type: "string" },
					reconcileIntervalMinutes: { type: "number", minimum: 1 },
				},
				required: ["dataDir"],
			},
		},
	},
} as const;

export const tapOpenClawPluginConfigSchema: OpenClawPluginConfigSchema = {
	parse: parseTapOpenClawPluginConfig,
	jsonSchema: JSON_SCHEMA,
	uiHints: UI_HINTS,
};

export function parseTapOpenClawPluginConfig(raw: unknown): TapOpenClawPluginConfig {
	if (raw === undefined || raw === null) {
		return { identities: [] };
	}

	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("TAP plugin config must be an object");
	}

	const input = raw as { identities?: unknown };
	if (input.identities === undefined) {
		return { identities: [] };
	}
	if (!Array.isArray(input.identities)) {
		throw new Error("TAP plugin config.identities must be an array");
	}

	const identities = input.identities.map((value, index) => parseIdentityConfig(value, index));
	const names = new Set<string>();
	const dataDirs = new Set<string>();
	for (const identity of identities) {
		if (names.has(identity.name)) {
			throw new Error(`Duplicate TAP plugin identity name: ${identity.name}`);
		}
		names.add(identity.name);

		const normalizedDataDir = resolve(identity.dataDir);
		if (dataDirs.has(normalizedDataDir)) {
			throw new Error(`Duplicate TAP plugin identity dataDir: ${identity.dataDir}`);
		}
		dataDirs.add(normalizedDataDir);
	}

	return { identities };
}

function parseIdentityConfig(value: unknown, index: number): TapOpenClawIdentityConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`TAP plugin identity at index ${index} must be an object`);
	}

	const input = value as {
		name?: unknown;
		dataDir?: unknown;
		reconcileIntervalMinutes?: unknown;
	};

	if (typeof input.dataDir !== "string" || input.dataDir.trim().length === 0) {
		throw new Error(`TAP plugin identity ${index + 1} is missing a valid dataDir`);
	}

	const name =
		typeof input.name === "string" && input.name.trim().length > 0
			? input.name.trim()
			: index === 0
				? "default"
				: `identity-${index + 1}`;
	const reconcileIntervalMinutes =
		typeof input.reconcileIntervalMinutes === "number" &&
		Number.isFinite(input.reconcileIntervalMinutes) &&
		input.reconcileIntervalMinutes >= 1
			? input.reconcileIntervalMinutes
			: DEFAULT_RECONCILE_INTERVAL_MINUTES;

	return {
		name,
		dataDir: input.dataDir.trim(),
		reconcileIntervalMinutes,
	};
}
