import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PermissionLedgerEntry {
	timestamp?: string;
	peer: string;
	direction?: "granted-by-me" | "granted-by-peer" | "local";
	event: string;
	grant_id?: string;
	scope?: string;
	asset?: string;
	amount?: string;
	period?: string;
	running_total_for_period?: string;
	limit_for_period?: string;
	action_id?: string;
	tx_hash?: string;
	decision?: string;
	rationale?: string;
	note?: string;
}

export function getPermissionLedgerPath(dataDir: string): string {
	return join(dataDir, "notes", "permissions-ledger.md");
}

export async function appendPermissionLedgerEntry(
	dataDir: string,
	entry: PermissionLedgerEntry,
): Promise<string> {
	const path = getPermissionLedgerPath(dataDir);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });

	const timestamp = entry.timestamp ?? new Date().toISOString();
	const lines = [`## ${timestamp}`];
	lines.push(`- peer: ${entry.peer}`);
	if (entry.direction) lines.push(`- direction: ${entry.direction}`);
	lines.push(`- event: ${entry.event}`);
	if (entry.grant_id) lines.push(`- grant_id: ${entry.grant_id}`);
	if (entry.scope) lines.push(`- scope: ${entry.scope}`);
	if (entry.asset) lines.push(`- asset: ${entry.asset}`);
	if (entry.amount) lines.push(`- amount: ${entry.amount}`);
	if (entry.period) lines.push(`- period: ${entry.period}`);
	if (entry.running_total_for_period) {
		lines.push(`- running_total_for_period: ${entry.running_total_for_period}`);
	}
	if (entry.limit_for_period) lines.push(`- limit_for_period: ${entry.limit_for_period}`);
	if (entry.action_id) lines.push(`- action_id: ${entry.action_id}`);
	if (entry.tx_hash) lines.push(`- tx_hash: ${entry.tx_hash}`);
	if (entry.decision) lines.push(`- decision: ${entry.decision}`);
	if (entry.rationale) lines.push(`- rationale: ${entry.rationale}`);
	if (entry.note) lines.push(`- note: ${entry.note}`);
	lines.push("");

	await appendFile(path, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
	return path;
}
