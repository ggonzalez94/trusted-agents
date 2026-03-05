import type { GlobalOptions } from "../types.js";

export interface Envelope<T = unknown> {
	ok: boolean;
	data?: T;
	error?: { code: string; message: string };
	meta?: { duration_ms: number; version: string };
}

function isJsonMode(opts: GlobalOptions): boolean {
	if (opts.json) return true;
	if (opts.plain) return false;
	return !process.stdout.isTTY;
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
	const envelope: Envelope<T> = { ok: true, data };
	if (startTime) {
		envelope.meta = {
			duration_ms: Date.now() - startTime,
			version: "0.1.0",
		};
	}

	if (isJsonMode(opts)) {
		process.stdout.write(`${JSON.stringify(envelope)}\n`);
	} else {
		printPlain(data);
	}
}

export function error(code: string, message: string, opts: GlobalOptions): void {
	const envelope: Envelope = {
		ok: false,
		error: { code, message },
	};

	if (isJsonMode(opts)) {
		process.stdout.write(`${JSON.stringify(envelope)}\n`);
	} else {
		process.stderr.write(`Error [${code}]: ${message}\n`);
	}
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
				if (typeof item === "object" && item !== null) {
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

function printKeyValue(label: string, val: unknown, maxLabelLen: number): void {
	// Nested object → indented pretty JSON
	if (typeof val === "object" && val !== null) {
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
	if (typeof first !== "object" || first === null) {
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
