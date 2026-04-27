import { createRequire } from "node:module";
import { isObject, isRecord } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import type { OutputFormat } from "../types.js";

interface Envelope<T = unknown> {
	status: "ok" | "error";
	data?: T;
	error?: { code: string; message: string };
	metadata: {
		command?: string;
		duration_ms?: number;
		format: OutputFormat;
		pagination?: {
			limit: number;
			offset: number;
			returned: number;
			total: number;
		};
		selected_fields?: string[];
		version: string;
	};
}

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

function resolveOutputFormat(opts: GlobalOptions): OutputFormat {
	if (opts.output === "json" || opts.output === "text" || opts.output === "ndjson") {
		return opts.output;
	}
	if (opts.json) return "json";
	if (opts.plain) return "text";

	const envFormat = process.env.TAP_OUTPUT_FORMAT ?? process.env.OUTPUT_FORMAT;
	if (envFormat === "json" || envFormat === "text" || envFormat === "ndjson") {
		return envFormat;
	}

	return process.stdout.isTTY ? "text" : "json";
}

/* ── Key label formatting ── */

const ACRONYMS = new Set(["id", "url", "uri", "cid", "xmtp", "ipfs", "ip", "ms"]);

function humanizeKey(key: string): string {
	return key
		.split("_")
		.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(" ");
}

/* ── Public helpers ── */

export function success<T>(data: T, opts: GlobalOptions, startTime?: number): void {
	const format = resolveOutputFormat(opts);
	const transformed = transformData(data, opts);
	if (format === "text") {
		printPlain(transformed.data);
		return;
	}
	if (format === "ndjson") {
		printNdjson(transformed.data);
		return;
	}

	const envelope: Envelope<T> = {
		status: "ok",
		data: transformed.data as T,
		metadata: buildMetadata(opts, format, startTime, transformed),
	};
	process.stdout.write(`${stableStringify(envelope)}\n`);
}

export function error(code: string, message: string, opts: GlobalOptions): void {
	const format = resolveOutputFormat(opts);
	const envelope: Envelope = {
		status: "error",
		error: { code, message },
		metadata: buildMetadata(opts, format),
	};

	if (format === "json" || format === "ndjson") {
		process.stdout.write(`${stableStringify(envelope)}\n`);
	} else {
		process.stderr.write(`Error [${code}]: ${message}\n`);
	}
}

function buildMetadata(
	opts: GlobalOptions,
	format: OutputFormat,
	startTime?: number,
	transformed?: TransformMetadata,
): Envelope["metadata"] {
	return {
		...(opts.commandPath ? { command: opts.commandPath } : {}),
		...(startTime !== undefined ? { duration_ms: Date.now() - startTime } : {}),
		format,
		...(transformed?.pagination ? { pagination: transformed.pagination } : {}),
		...(transformed?.selectedFields ? { selected_fields: transformed.selectedFields } : {}),
		version,
	};
}

/* ── Plain-text rendering ── */

function printPlain(data: unknown): void {
	if (data === null || data === undefined) return;

	if (Array.isArray(data)) {
		for (const item of data) {
			printPlain(item);
		}
		return;
	}

	if (typeof data === "object") {
		const obj = data as Record<string, unknown>;

		// Check if it's a list wrapper (e.g. { contacts: [...] })
		const keys = Object.keys(obj);
		if (keys.length === 1) {
			const value = obj[keys[0]!];
			if (Array.isArray(value)) {
				printTable(value);
				return;
			}
		}

		// Key-value display — render arrays as bulleted lists below the key
		const scalarEntries: [string, unknown][] = [];
		const arrayEntries: [string, unknown[]][] = [];

		for (const [key, val] of Object.entries(obj)) {
			if (Array.isArray(val)) {
				arrayEntries.push([key, val]);
			} else {
				scalarEntries.push([key, val]);
			}
		}

		if (scalarEntries.length > 0) {
			const labels = scalarEntries.map(([k]) => humanizeKey(k));
			const maxLabelLen = Math.max(0, ...labels.map((l) => l.length));
			for (let i = 0; i < scalarEntries.length; i++) {
				printKeyValue(labels[i]!, scalarEntries[i]![1], maxLabelLen);
			}
		}

		for (const [key, items] of arrayEntries) {
			process.stdout.write(`\n${humanizeKey(key)}:\n`);
			for (const item of items) {
				if (isObject(item)) {
					const lines = JSON.stringify(item, null, 2).split("\n");
					process.stdout.write(`  - ${lines[0]}\n`);
					for (const line of lines.slice(1)) {
						process.stdout.write(`    ${line}\n`);
					}
					continue;
				}

				const str = String(item);
				// Indented lines are continuation — print as-is; top-level lines get a bullet
				if (str.startsWith("  ")) {
					process.stdout.write(`   ${str}\n`);
				} else {
					process.stdout.write(`  - ${str}\n`);
				}
			}
		}
		return;
	}

	process.stdout.write(`${String(data)}\n`);
}

function printNdjson(data: unknown): void {
	if (data === null || data === undefined) {
		return;
	}

	if (Array.isArray(data)) {
		for (const item of data) {
			process.stdout.write(`${stableStringify(item)}\n`);
		}
		return;
	}

	if (isObject(data)) {
		const obj = data as Record<string, unknown>;
		const entries = Object.entries(obj).filter(([, value]) => Array.isArray(value));
		if (entries.length === 1) {
			for (const item of entries[0]![1] as unknown[]) {
				process.stdout.write(`${stableStringify(item)}\n`);
			}
			return;
		}
	}

	process.stdout.write(`${stableStringify(data)}\n`);
}

function printKeyValue(label: string, val: unknown, maxLabelLen: number): void {
	// Nested object → indented pretty JSON
	if (isObject(val)) {
		process.stdout.write(`${label}:\n`);
		const json = JSON.stringify(val, null, 2);
		for (const line of json.split("\n")) {
			process.stdout.write(`  ${line}\n`);
		}
		return;
	}

	const displayVal = String(val ?? "-");

	// Multiline value → display on next line, indented
	if (displayVal.includes("\n")) {
		process.stdout.write(`${label}:\n`);
		for (const line of displayVal.split("\n")) {
			process.stdout.write(`  ${line}\n`);
		}
		return;
	}

	const pad = " ".repeat(maxLabelLen - label.length);
	process.stdout.write(`${label}:  ${pad}${displayVal}\n`);
}

/* ── Table rendering ── */

function printTable(rows: unknown[]): void {
	if (rows.length === 0) {
		process.stdout.write("(none)\n");
		return;
	}

	const first = rows[0];
	if (!isObject(first)) {
		for (const row of rows) {
			process.stdout.write(`${String(row)}\n`);
		}
		return;
	}

	const rawHeaders = Object.keys(first);
	const headers = rawHeaders.map(humanizeKey);
	const colWidths = headers.map((h, idx) =>
		Math.max(
			h.length,
			...rows.map((r) => {
				const val = (r as Record<string, unknown>)[rawHeaders[idx]!];
				return String(val ?? "").length;
			}),
		),
	);

	// Header
	const headerLine = headers.map((h, i) => h.padEnd(colWidths[i]!)).join("  ");
	process.stdout.write(`${headerLine}\n`);
	process.stdout.write(`${colWidths.map((w) => "-".repeat(w)).join("  ")}\n`);

	// Rows
	for (const row of rows) {
		const vals = rawHeaders.map((h, i) => {
			const val = (row as Record<string, unknown>)[h];
			return String(val ?? "").padEnd(colWidths[i]!);
		});
		process.stdout.write(`${vals.join("  ")}\n`);
	}
}

export function verbose(message: string, opts: GlobalOptions): void {
	if (opts.verbose) {
		process.stderr.write(`[verbose] ${message}\n`);
	}
}

export function info(message: string, opts: GlobalOptions): void {
	if (!opts.quiet) {
		process.stderr.write(`${message}\n`);
	}
}

interface TransformMetadata {
	data: unknown;
	pagination?: {
		limit: number;
		offset: number;
		returned: number;
		total: number;
	};
	selectedFields?: string[];
}

function transformData(data: unknown, opts: GlobalOptions): TransformMetadata {
	let transformed = data;
	let selectedFields: string[] | undefined;
	let pagination: TransformMetadata["pagination"];

	const fields = parseFieldSelection(opts.select ?? opts.fields);
	if (fields) {
		transformed = applyFieldSelection(transformed, fields);
		selectedFields = fields;
	}

	const limit = parseNonNegativeInteger(opts.limit);
	const offset = parseNonNegativeInteger(opts.offset) ?? 0;
	if (limit !== undefined || offset > 0) {
		const paginated = applyPagination(transformed, limit, offset);
		transformed = paginated.data;
		pagination = paginated.pagination;
	}

	return {
		data: transformed,
		...(pagination ? { pagination } : {}),
		...(selectedFields ? { selectedFields } : {}),
	};
}

function parseFieldSelection(raw: string | undefined): string[] | undefined {
	if (!raw) {
		return undefined;
	}

	const fields = raw
		.split(",")
		.map((field) => field.trim())
		.filter(Boolean);

	return fields.length > 0 ? fields : undefined;
}

function parseNonNegativeInteger(raw: string | number | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return undefined;
	}
	return parsed;
}

function applyFieldSelection(data: unknown, fields: string[]): unknown {
	if (Array.isArray(data)) {
		return data.map((item) => selectFields(item, fields));
	}

	if (!isObject(data)) {
		return data;
	}

	const obj = data as Record<string, unknown>;
	const arrayEntries = Object.entries(obj).filter(([, value]) => Array.isArray(value));
	if (arrayEntries.length === 1) {
		const [arrayKey, arrayValue] = arrayEntries[0]!;
		return {
			...Object.fromEntries(Object.entries(obj).filter(([key]) => key !== arrayKey)),
			[arrayKey]: (arrayValue as unknown[]).map((item) => selectFields(item, fields)),
		};
	}

	return selectFields(obj, fields);
}

function selectFields(value: unknown, fields: string[]): unknown {
	if (!isRecord(value)) {
		return value;
	}

	const result: Record<string, unknown> = {};
	for (const field of fields) {
		const path = field.split(".").filter(Boolean);
		const selected = getPath(value, path);
		if (selected !== undefined) {
			setPath(result, path, selected);
		}
	}

	return result;
}

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
	let current: unknown = obj;
	for (const segment of path) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
	let current = target;
	for (let index = 0; index < path.length; index += 1) {
		const segment = path[index]!;
		if (index === path.length - 1) {
			current[segment] = value;
			return;
		}

		const existing = current[segment];
		if (!isRecord(existing)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
}

function applyPagination(
	data: unknown,
	limit: number | undefined,
	offset: number,
): {
	data: unknown;
	pagination?: TransformMetadata["pagination"];
} {
	if (Array.isArray(data)) {
		return paginateArray(data, limit, offset, (items) => items);
	}

	if (!isObject(data)) {
		return { data };
	}

	const obj = data as Record<string, unknown>;
	const arrayEntries = Object.entries(obj).filter(([, value]) => Array.isArray(value));
	if (arrayEntries.length !== 1) {
		return { data };
	}

	const [arrayKey, arrayValue] = arrayEntries[0]!;
	const paginated = paginateArray(arrayValue as unknown[], limit, offset, (items) => ({
		...Object.fromEntries(Object.entries(obj).filter(([key]) => key !== arrayKey)),
		[arrayKey]: items,
	}));

	return paginated;
}

function paginateArray<T>(
	items: T[],
	limit: number | undefined,
	offset: number,
	wrap: (items: T[]) => unknown,
): {
	data: unknown;
	pagination: NonNullable<TransformMetadata["pagination"]>;
} {
	const boundedOffset = Math.min(offset, items.length);
	const sliced =
		limit === undefined
			? items.slice(boundedOffset)
			: items.slice(boundedOffset, boundedOffset + limit);

	return {
		data: wrap(sliced),
		pagination: {
			limit: limit ?? sliced.length,
			offset: boundedOffset,
			returned: sliced.length,
			total: items.length,
		},
	};
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortValue);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, innerValue]) => [key, sortValue(innerValue)]),
	);
}
