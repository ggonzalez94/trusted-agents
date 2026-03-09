import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type TransportOwnerInfo,
	TransportOwnerLock,
	isProcessAlive,
	resolveDataDir as resolveAbsoluteDataDir,
} from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import YAML from "yaml";
import { resolveDataDir as resolveCliDataDir } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";
import type { GlobalOptions } from "../types.js";

export interface RemoveOptions {
	dryRun?: boolean;
	unsafeWipeDataDir?: boolean;
	yes?: boolean;
}

interface RemoveStoredConfig {
	agent_id?: number;
}

interface DataDirInspection {
	hasManagedEntries: boolean;
	managedEntries: string[];
	unexpectedEntries: string[];
}

export interface RemovePlan {
	dataDir: string;
	configPath: string;
	agentId: number | null;
	address: string | null;
	pathsToRemove: string[];
	warnings: string[];
	liveTransportOwner: TransportOwnerInfo | null;
	blockingReasons: string[];
}

const TAP_DATA_DIR_ENTRIES = new Set([
	".transport.lock",
	"config.yaml",
	"contacts.json",
	"conversations",
	"identity",
	"ipfs-cache.json",
	"notes",
	"pending-invites.json",
	"request-journal.json",
	"xmtp",
]);

export async function removeCommand(cmdOpts: RemoveOptions, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const plan = await buildRemovePlan(opts);

		if (cmdOpts.dryRun) {
			success(
				{
					dry_run: true,
					data_dir: plan.dataDir,
					config_path: plan.configPath,
					agent_id: plan.agentId,
					address: plan.address,
					paths_to_remove: plan.pathsToRemove,
					live_transport_owner: plan.liveTransportOwner,
					blocking_reasons: plan.blockingReasons,
					can_remove:
						plan.liveTransportOwner === null &&
						plan.blockingReasons.length === 0 &&
						plan.pathsToRemove.length > 0,
					warnings: plan.warnings,
				},
				opts,
				startTime,
			);
			return;
		}

		if (!cmdOpts.unsafeWipeDataDir) {
			error(
				"VALIDATION_ERROR",
				"Refusing to remove local TAP data without --unsafe-wipe-data-dir. Use --dry-run to inspect what would be removed.",
				opts,
			);
			process.exitCode = 2;
			return;
		}

		if (plan.liveTransportOwner) {
			error(
				"TRANSPORT_OWNERSHIP_ERROR",
				`Refusing to remove local TAP data while ${plan.liveTransportOwner.owner} (pid ${plan.liveTransportOwner.pid}) owns the transport for this data dir.`,
				opts,
			);
			process.exitCode = 1;
			return;
		}

		if (plan.blockingReasons.length > 0) {
			error("VALIDATION_ERROR", plan.blockingReasons.join(" "), opts);
			process.exitCode = 2;
			return;
		}

		if (plan.pathsToRemove.length === 0) {
			success(
				{
					removed: false,
					data_dir: plan.dataDir,
					config_path: plan.configPath,
					agent_id: plan.agentId,
					address: plan.address,
					removed_paths: [],
					warnings: [...plan.warnings, "No local TAP data was found to remove."],
				},
				opts,
				startTime,
			);
			return;
		}

		if (!isInteractiveSession() && !cmdOpts.yes) {
			error(
				"VALIDATION_ERROR",
				"Non-interactive removal requires both --unsafe-wipe-data-dir and --yes.",
				opts,
			);
			process.exitCode = 2;
			return;
		}

		if (isInteractiveSession()) {
			const confirmed = await promptYesNo(
				`Remove local TAP agent data at ${plan.dataDir}? This deletes the entire data dir and cannot be undone. [y/N] `,
			);
			if (!confirmed) {
				success(
					{
						removed: false,
						aborted: true,
						data_dir: plan.dataDir,
						reason: "Confirmation declined. No local TAP data was removed.",
					},
					opts,
					startTime,
				);
				return;
			}
		}

		await rm(plan.dataDir, { recursive: true, force: true });

		success(
			{
				removed: true,
				data_dir: plan.dataDir,
				config_path: plan.configPath,
				agent_id: plan.agentId,
				address: plan.address,
				removed_paths: plan.pathsToRemove,
				warnings: plan.warnings,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function buildRemovePlan(opts: GlobalOptions): Promise<RemovePlan> {
	const dataDir = await resolveRemoveDataDir(opts);
	const configPath = resolveRemoveConfigPath(opts, dataDir);
	const warnings = [
		"This only removes local TAP agent data. It does not unregister the ERC-8004 agent or notify peers.",
		"Host runtime config that still points at this data dir is not updated automatically, including OpenClaw plugin identity settings.",
	];
	const blockingReasons: string[] = [];
	const [agentId, configWarning] = await readAgentId(configPath);
	const [address, keyWarning] = await readAgentAddress(dataDir);
	const liveTransportOwner = await inspectLiveTransportOwner(dataDir);
	const inspection = await inspectDataDir(dataDir);

	if (configWarning) {
		warnings.push(configWarning);
	}
	if (keyWarning) {
		warnings.push(keyWarning);
	}
	if (liveTransportOwner) {
		warnings.push(
			`Removal is currently blocked because ${liveTransportOwner.owner} (pid ${liveTransportOwner.pid}) owns the TAP transport for this data dir.`,
		);
	}
	if (dataDir === resolve("/")) {
		blockingReasons.push("Refusing to remove /. Use a TAP agent data dir instead.");
	}
	if (dataDir === resolve(homedir())) {
		blockingReasons.push(
			"Refusing to remove the current home directory. Use a TAP agent data dir instead.",
		);
	}
	if (inspection.unexpectedEntries.length > 0) {
		const listedEntries = inspection.unexpectedEntries.map((entry) => `"${entry}"`).join(", ");
		const message = `Refusing to remove ${dataDir} because it contains non-TAP top-level entries: ${listedEntries}.`;
		blockingReasons.push(message);
		warnings.push(`${message} TAP remove only wipes TAP-owned data dirs.`);
	}

	return {
		dataDir,
		configPath,
		agentId,
		address,
		pathsToRemove: await collectPlannedRemovalPaths(dataDir, inspection),
		warnings,
		liveTransportOwner,
		blockingReasons,
	};
}

async function resolveRemoveDataDir(opts: GlobalOptions): Promise<string> {
	const configuredPath = resolveAbsoluteDataDir(resolveCliDataDir(opts));
	try {
		return await realpath(configuredPath);
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return configuredPath;
		}
		throw error;
	}
}

function resolveRemoveConfigPath(opts: GlobalOptions, dataDir: string): string {
	const configPath = join(dataDir, "config.yaml");
	if (!opts.config) {
		return configPath;
	}

	if (resolve(opts.config) !== resolve(configPath)) {
		throw new Error(
			"`tap remove` only supports config.yaml inside the resolved data dir. External config paths are not supported.",
		);
	}

	return configPath;
}

async function readAgentId(configPath: string): Promise<[number | null, string | null]> {
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = (YAML.parse(raw) as RemoveStoredConfig | null | undefined) ?? undefined;
		if (typeof parsed?.agent_id === "number" && Number.isFinite(parsed.agent_id)) {
			return [parsed.agent_id, null];
		}
		return [null, "config.yaml is present but agent_id could not be read."];
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [null, "config.yaml is missing from the resolved data dir."];
		}
		return [
			null,
			`config.yaml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

async function readAgentAddress(dataDir: string): Promise<[string | null, string | null]> {
	const keyPath = join(dataDir, "identity", "agent.key");
	try {
		const raw = (await readFile(keyPath, "utf-8")).trim();
		if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
			return [null, `identity/agent.key is present but invalid at ${keyPath}.`];
		}
		return [privateKeyToAccount(`0x${raw}`).address, null];
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [null, "identity/agent.key is missing from the resolved data dir."];
		}
		return [
			null,
			`identity/agent.key could not be read: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

async function inspectLiveTransportOwner(dataDir: string): Promise<TransportOwnerInfo | null> {
	const lock = new TransportOwnerLock(dataDir, "tap remove");
	const owner = await lock.inspect();
	if (!owner) {
		return null;
	}
	return isProcessAlive(owner.pid) ? owner : null;
}

async function inspectDataDir(dataDir: string): Promise<DataDirInspection> {
	try {
		const entries = await readdir(dataDir);
		const managedEntries = entries.filter((entry) => TAP_DATA_DIR_ENTRIES.has(entry));
		const unexpectedEntries = entries.filter((entry) => !TAP_DATA_DIR_ENTRIES.has(entry));
		return {
			hasManagedEntries: managedEntries.length > 0,
			managedEntries,
			unexpectedEntries,
		};
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return { hasManagedEntries: false, managedEntries: [], unexpectedEntries: [] };
		}
		throw error;
	}
}

async function collectPlannedRemovalPaths(
	dataDir: string,
	inspection: DataDirInspection,
): Promise<string[]> {
	if (!inspection.hasManagedEntries) {
		return [];
	}

	const paths: string[] = [];
	if (inspection.unexpectedEntries.length === 0) {
		paths.push(dataDir);
	}

	for (const entry of inspection.managedEntries.sort((left, right) => left.localeCompare(right))) {
		paths.push(...(await collectRemovalPaths(join(dataDir, entry))));
	}

	return paths;
}

async function collectRemovalPaths(targetPath: string): Promise<string[]> {
	try {
		const stat = await lstat(targetPath);
		const paths = [targetPath];
		if (!stat.isDirectory()) {
			return paths;
		}

		const entries = await readdir(targetPath);
		entries.sort((left, right) => left.localeCompare(right));
		for (const entry of entries) {
			paths.push(...(await collectRemovalPaths(join(targetPath, entry))));
		}
		return paths;
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

function isInteractiveSession(): boolean {
	return Boolean(process.stdin.isTTY);
}
