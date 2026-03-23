# Release and Distribution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag-triggered CI pipeline that publishes CLI, core, and OpenClaw plugin to npm, with skill distribution via `npx skills add`.

**Architecture:** Delete the unused SDK package, move skills to repo root, update package.json files for npm publishing, rewrite `install.ts` to use npm channels instead of symlinks, create a GitHub Actions release workflow triggered by `v*` tags.

**Tech Stack:** GitHub Actions, bun publish, npm registry, `npx skills` CLI

**Spec:** `docs/superpowers/specs/2026-03-23-release-and-distribution-design.md`

---

### Task 1: Move skills to repo root and delete SDK

**Files:**
- Move: `packages/sdk/skills/trusted-agents/` -> `skills/trusted-agents/`
- Delete: `packages/sdk/` (entire directory)
- Modify: `tsconfig.json`
- Modify: `package.json` (root)

- [ ] **Step 1: Move the canonical skill files to repo root**

```bash
git mv packages/sdk/skills/trusted-agents skills/trusted-agents
rm -rf skills/trusted-agents/evals
```

Uses `git mv` to preserve rename tracking. Keep `SKILL.md` and `references/permissions-v1.md`. Drop `evals/` — not needed for distribution.

- [ ] **Step 2: Delete the SDK package**

```bash
rm -rf packages/sdk
```

- [ ] **Step 3: Remove SDK from root tsconfig.json**

Update `tsconfig.json` to:
```json
{
  "files": [],
  "references": [
    { "path": "packages/core" }
  ]
}
```

- [ ] **Step 4: Remove SDK from root package.json typecheck script**

In `package.json`, change the `typecheck` script from:
```
bun run --cwd packages/core typecheck && bun run --cwd packages/core build && bun run --cwd packages/sdk typecheck && bun run --cwd packages/cli typecheck && bun run --cwd packages/openclaw-plugin typecheck
```
to:
```
bun run --cwd packages/core typecheck && bun run --cwd packages/core build && bun run --cwd packages/cli typecheck && bun run --cwd packages/openclaw-plugin typecheck
```

- [ ] **Step 5: Verify the build still works**

Run: `bun install && bun run typecheck && bun run build && bun run test`
Expected: All pass. The `packages/*` workspace glob auto-excludes the deleted sdk.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete packages/sdk, move skills to repo root"
```

---

### Task 2: Remove old OpenClaw plugin symlinks

**Files:**
- Delete: `packages/openclaw-plugin/skills/trusted-agents` (symlink)
- Delete: `packages/openclaw-plugin/skills/trusted-agents-openclaw/` (directory with symlinks)
- Modify: `.gitignore`

- [ ] **Step 1: Remove the existing symlinks from the OpenClaw plugin**

Current state: `packages/openclaw-plugin/skills/trusted-agents` is a symlink to `../../sdk/skills/trusted-agents` (now broken since SDK was deleted). `packages/openclaw-plugin/skills/trusted-agents-openclaw/` is a directory containing symlinked `SKILL.md` and `references/permissions-v1.md` (also broken).

```bash
rm -f packages/openclaw-plugin/skills/trusted-agents
rm -rf packages/openclaw-plugin/skills/trusted-agents-openclaw
```

- [ ] **Step 2: Add the plugin skills directory to .gitignore**

Append to `.gitignore`:
```
packages/openclaw-plugin/skills/
```

This directory will be populated at build time from the repo-root `skills/` source of truth.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove openclaw plugin skill symlinks, gitignore build copies"
```

---

### Task 3: Update package.json files for npm publishing

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/openclaw-plugin/package.json`

- [ ] **Step 1: Update packages/core/package.json**

Add `"files"` and `"engines"` fields:
```json
{
  "name": "trusted-agents-core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "exports": {
```

- [ ] **Step 2: Update packages/cli/package.json**

Add `"files"` and `"engines"` fields:
```json
{
  "name": "trusted-agents-cli",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "tap": "./dist/bin.js"
  },
  "files": ["dist"],
  "engines": { "node": ">=18" },
```

- [ ] **Step 3: Update packages/openclaw-plugin/package.json**

Remove `"private": true`. Add `"files"`, `"engines"`, `"peerDependencies"`, `"peerDependenciesMeta"`. Remove `openclaw` from `dependencies`:

```json
{
  "name": "trusted-agents-tap",
  "version": "0.1.0",
  "description": "OpenClaw plugin for running TAP as a Gateway background service",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "skills", "openclaw.plugin.json"],
  "engines": { "node": ">=18" },
  "scripts": {
    "prebuild": "rm -rf skills && mkdir -p skills && cp -r ../../skills/trusted-agents skills/trusted-agents",
    "build": "tsc -p tsconfig.json",
    "typecheck": "bun run --cwd ../core build && tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.48",
    "trusted-agents-core": "workspace:*",
    "viem": "2.46.3"
  },
  "peerDependencies": {
    "openclaw": ">=2026.1.29"
  },
  "peerDependenciesMeta": {
    "openclaw": { "optional": true }
  },
  "devDependencies": {
    "@types/node": "^25.3.3",
    "openclaw": "2026.3.2",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

Note: `openclaw` moves to `devDependencies` so it's available during development/testing but not installed as a production dependency. It becomes a peer dep for consumers.

Note: The `"openclaw": { "extensions": ["./index.ts"] }` field stays as-is. OpenClaw resolves extensions relative to the plugin root and handles `.ts` → `.js` resolution internally. This is how other published OpenClaw plugins work (e.g., `@supermemory/openclaw-supermemory`).

Note: `bun run build` at the root calls `bun run --filter '*' build`, which runs each package's `build` script. The `prebuild` lifecycle hook runs automatically before `build` for the openclaw-plugin, so skills are copied before TypeScript compilation.

- [ ] **Step 4: Verify the build still works**

Run: `bun install && bun run build && bun run test`
Expected: All pass. The `prebuild` script should have copied skills into `packages/openclaw-plugin/skills/trusted-agents/`.

- [ ] **Step 5: Verify skill copy happened**

Run: `ls packages/openclaw-plugin/skills/trusted-agents/SKILL.md`
Expected: File exists (copied from repo root `skills/trusted-agents/`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: configure package.json files for npm publishing"
```

---

### Task 4: Rewrite install.ts for npm-based distribution

**Files:**
- Modify: `packages/cli/src/commands/install.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/test/install.test.ts`

- [ ] **Step 1: Write the failing test for the new install behavior**

Rewrite `packages/cli/test/install.test.ts`. The new install command doesn't need a `sourceDir` — it uses `npx skills add` for Claude/Codex and `openclaw plugins install trusted-agents-tap` for OpenClaw.

```typescript
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand } from "../src/commands/install.js";

describe("tap install", () => {
	let tempRoot: string;
	let homeDir: string;
	let binDir: string;
	let originalHome: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-install-"));
		homeDir = join(tempRoot, "home");
		binDir = join(tempRoot, "bin");
		await mkdir(homeDir, { recursive: true });
		await mkdir(binDir, { recursive: true });

		originalHome = process.env.HOME;
		originalPath = process.env.PATH;
		process.env.HOME = homeDir;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = JSON.stringify({ valid: true });
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = gatewayStatusJson({
			serviceLoaded: false,
			runtimeStatus: "stopped",
			rpcOk: false,
		});
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_1 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_2 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_3 = "";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = "20";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_POLL_MS = "1";
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		process.env.PATH = originalPath;
		process.env.FAKE_OPENCLAW_CONFIG_VALIDATE_JSON = "";
		process.env.FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_1 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_2 = "";
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_3 = "";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = "";
		process.env.TAP_OPENCLAW_GATEWAY_WAIT_POLL_MS = "";
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("installs skills for Claude via npx skills add and OpenClaw plugin from npm", async () => {
		await mkdir(join(homeDir, ".claude"), { recursive: true });
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));

		await installCommand({ runtimes: [] }, { json: true });

		const npxLog = await readFile(join(tempRoot, "npx.log"), "utf-8");
		expect(npxLog).toContain("skills add ggonzalez94/trusted-agents");

		const pluginLog = await readFile(join(tempRoot, "openclaw.log"), "utf-8");
		expect(pluginLog).toContain("plugins install trusted-agents-tap");
	});

	it("installs the OpenClaw plugin from npm without npx skills", async () => {
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"] }, { json: true });

		const commands = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(commands).toEqual(
			expect.arrayContaining([expect.stringContaining("plugins install trusted-agents-tap")]),
		);
	});

	it("installs Claude skills via npx skills add when Claude runtime requested", async () => {
		await writeFakeNpx(binDir, join(tempRoot, "npx.log"));

		await installCommand({ runtimes: ["claude"] }, { json: true });

		const npxLog = await readFile(join(tempRoot, "npx.log"), "utf-8");
		expect(npxLog).toContain("skills add ggonzalez94/trusted-agents");
	});

	it("reports no runtimes detected when none exist", async () => {
		// No ~/.claude, ~/.codex, no openclaw on PATH
		await installCommand({ runtimes: [] }, { json: true });
		// Should succeed without error — just report nothing detected
		expect(process.exitCode).toBeUndefined();
	});

	it("reports an error when npx skills add fails", async () => {
		await writeFakeNpxFailing(binDir);

		await installCommand({ runtimes: ["claude"] }, { json: true });

		expect(process.exitCode).toBeGreaterThan(0);
	});

	it("waits for OpenClaw Gateway reload after plugin install", async () => {
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_1 = gatewayStatusJson({
			serviceLoaded: true,
			runtimeStatus: "running",
			runtimePid: 101,
			rpcOk: true,
		});
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_2 = gatewayStatusJson({
			serviceLoaded: true,
			runtimeStatus: "running",
			runtimePid: 101,
			rpcOk: true,
		});
		process.env.FAKE_OPENCLAW_GATEWAY_STATUS_JSON_3 = gatewayStatusJson({
			serviceLoaded: true,
			runtimeStatus: "running",
			runtimePid: 202,
			rpcOk: true,
		});
		await writeFakeOpenClaw(binDir, join(tempRoot, "openclaw.log"));

		await installCommand({ runtimes: ["openclaw"] }, { json: true });

		const commands = await readCommandLog(join(tempRoot, "openclaw.log"));
		expect(commands.filter((c) => c === "gateway status --json").length).toBeGreaterThanOrEqual(2);
	});
});

// --- Test helpers ---

async function writeFakeOpenClaw(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "openclaw");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"

if [[ "$1" == "config" && "$2" == "validate" ]]; then
  validate_json="$FAKE_OPENCLAW_CONFIG_VALIDATE_JSON"
  if [[ -z "$validate_json" ]]; then
    validate_json='{"valid":true}'
  fi
  printf '%s\\n' "$validate_json"
  exit 0
fi

if [[ "$1" == "plugins" && "$2" == "install" ]]; then
  exit "\${FAKE_OPENCLAW_PLUGIN_INSTALL_EXIT_CODE:-0}"
fi

if [[ "$1" == "gateway" && "$2" == "status" ]]; then
  status_count="$(grep -c '^gateway status --json$' "${logPath}" || true)"
  status_json_var="FAKE_OPENCLAW_GATEWAY_STATUS_JSON_\${status_count}"
  status_json="\${!status_json_var:-$FAKE_OPENCLAW_GATEWAY_STATUS_JSON}"
  if [[ -z "$status_json" ]]; then
    status_json='{"service":{"loaded":false},"rpc":{"ok":false}}'
  fi
  printf '%s\\n' "$status_json"
  exit 0
fi
`,
	);
	await chmod(scriptPath, 0o755);
}

async function writeFakeNpx(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "npx");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"
exit 0
`,
	);
	await chmod(scriptPath, 0o755);
}

async function writeFakeNpxFailing(binDir: string): Promise<void> {
	const scriptPath = join(binDir, "npx");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
echo "npx: command failed" >&2
exit 1
`,
	);
	await chmod(scriptPath, 0o755);
}

function gatewayStatusJson(params: {
	serviceLoaded: boolean;
	runtimeStatus: string;
	runtimePid?: number;
	rpcOk: boolean;
}): string {
	return JSON.stringify({
		service: {
			loaded: params.serviceLoaded,
			runtime:
				params.runtimePid === undefined
					? { status: params.runtimeStatus }
					: { status: params.runtimeStatus, pid: params.runtimePid },
		},
		rpc: { ok: params.rpcOk },
	});
}

async function readCommandLog(path: string): Promise<string[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/cli && bun run test -- --testPathPattern install`
Expected: FAIL — the current `installCommand` expects `sourceDir`.

- [ ] **Step 3: Rewrite install.ts**

Replace `packages/cli/src/commands/install.ts` entirely with:

```typescript
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { commandExists } from "../lib/shell.js";
import type { GlobalOptions } from "../types.js";

const execFileAsync = promisify(execFile);

const SKILLS_REPO = "ggonzalez94/trusted-agents";
const OPENCLAW_PLUGIN_NAME = "trusted-agents-tap";
const SUPPORTED_RUNTIMES = ["claude", "codex", "openclaw"] as const;
const DEFAULT_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_OPENCLAW_GATEWAY_WAIT_POLL_MS = 500;

type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

export interface InstallOptions {
	runtimes?: string[];
}

interface RuntimeInstallResult {
	runtime: SupportedRuntime;
	detected: boolean;
	skills_installed: boolean;
	plugin_installed?: boolean;
	notes: string[];
}

interface OpenClawGatewayStatus {
	serviceLoaded: boolean;
	runtimeStatus: string | null;
	runtimePid: number | null;
	rpcOk: boolean;
}

export async function installCommand(cmdOpts: InstallOptions, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const homeDir = resolveHomeDir();
		const runtimes = resolveRequestedRuntimes(cmdOpts.runtimes);
		const autoDetect = runtimes.length === 0;
		const results: RuntimeInstallResult[] = [];

		for (const runtime of autoDetect ? SUPPORTED_RUNTIMES : runtimes) {
			const runtimeDir = join(homeDir, `.${runtime}`);
			const detected =
				existsSync(runtimeDir) || (runtime === "openclaw" && (await commandExists("openclaw")));
			if (autoDetect && !detected) {
				continue;
			}

			const notes: string[] = [];
			const result: RuntimeInstallResult = {
				runtime,
				detected,
				skills_installed: false,
				notes,
			};

			if (runtime === "claude" || runtime === "codex") {
				await installSkills(notes);
				result.skills_installed = true;
			}

			if (runtime === "openclaw") {
				const pluginResult = await installOpenClawPlugin(autoDetect, notes);
				result.plugin_installed = pluginResult.installed;
			}

			results.push(result);
		}

		if (results.length === 0) {
			success(
				{
					installed: false,
					reason:
						"No supported runtimes detected. Looked for ~/.claude, ~/.codex, ~/.openclaw, and the openclaw CLI.",
					next_steps: [
						"Create the target runtime directory or pass --runtime <name> to install explicitly.",
					],
				},
				opts,
				startTime,
			);
			return;
		}

		success(
			{
				installed: true,
				runtimes: results,
				next_steps: [
					"Run `tap init` to create or import the TAP identity.",
					"Fund the wallet, then run `tap register`.",
				],
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function resolveHomeDir(): string {
	const envHome = process.env.HOME?.trim();
	return envHome && envHome.length > 0 ? envHome : homedir();
}

function resolveRequestedRuntimes(input: string[] | undefined): SupportedRuntime[] {
	if (!input || input.length === 0) {
		return [];
	}
	return input.map((entry) => parseRuntime(entry));
}

function parseRuntime(value: string): SupportedRuntime {
	const normalized = value.trim().toLowerCase();
	const match = SUPPORTED_RUNTIMES.find((runtime) => runtime === normalized);
	if (!match) {
		throw new Error(`Unsupported runtime: ${value}. Use one of: ${SUPPORTED_RUNTIMES.join(", ")}`);
	}
	return match;
}

async function installSkills(notes: string[]): Promise<void> {
	try {
		await execFileAsync("npx", ["skills", "add", SKILLS_REPO], {
			env: process.env,
			encoding: "utf8",
			timeout: 120_000,
		});
		notes.push(`Installed TAP skills via npx skills add ${SKILLS_REPO}.`);
	} catch (err) {
		throw new Error(
			`Failed to install skills via npx skills add ${SKILLS_REPO}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function installOpenClawPlugin(
	autoDetect: boolean,
	notes: string[],
): Promise<{ installed: boolean }> {
	const hasOpenClaw = await commandExists("openclaw");
	if (!hasOpenClaw) {
		if (autoDetect) {
			notes.push("OpenClaw CLI not found; skipped plugin installation.");
			return { installed: false };
		}
		throw new Error("OpenClaw CLI not found on PATH. Install OpenClaw or omit --runtime openclaw.");
	}

	const gatewayStatusBeforeInstall = await getOpenClawGatewayStatus();
	const waitForGatewayReload = isHealthyOpenClawGatewayStatus(gatewayStatusBeforeInstall);

	await execOpenClawCommand(["plugins", "install", OPENCLAW_PLUGIN_NAME]);
	notes.push(`Installed the TAP OpenClaw plugin (${OPENCLAW_PLUGIN_NAME}) from npm.`);
	await validateOpenClawConfig(notes);

	if (waitForGatewayReload) {
		await waitForOpenClawGatewayReload(gatewayStatusBeforeInstall, notes);
	} else if (gatewayStatusBeforeInstall?.serviceLoaded) {
		notes.push(
			"The OpenClaw Gateway service was not healthy before install, so TAP installed the plugin without waiting for runtime readiness.",
		);
	} else {
		notes.push(
			"The OpenClaw Gateway was not running during install. Start it after configuring TAP identities.",
		);
	}

	return { installed: true };
}

// --- OpenClaw helpers (kept from original) ---

async function validateOpenClawConfig(notes: string[]): Promise<void> {
	const result = await execOpenClawJsonCommand(["config", "validate", "--json"]);
	if (result.valid !== true) {
		const issues = Array.isArray(result.issues)
			? result.issues
					.map((issue) => {
						if (!isRecord(issue)) {
							return null;
						}
						const message = typeof issue.message === "string" ? issue.message.trim() : "";
						return message || null;
					})
					.filter((message): message is string => Boolean(message))
			: [];
		const detail =
			issues.length > 0
				? issues.join("; ")
				: "OpenClaw reported an invalid config after plugin install.";
		throw new Error(`OpenClaw config validation failed after plugin install: ${detail}`);
	}
	notes.push("Validated the OpenClaw config after plugin install.");
}

async function getOpenClawGatewayStatus(): Promise<OpenClawGatewayStatus> {
	const result = await execOpenClawJsonCommand(["gateway", "status", "--json"]);
	return parseOpenClawGatewayStatus(result);
}

async function readOpenClawGatewayStatus(): Promise<OpenClawGatewayStatus | null> {
	try {
		return await getOpenClawGatewayStatus();
	} catch {
		return null;
	}
}

function parseOpenClawGatewayStatus(result: Record<string, unknown>): OpenClawGatewayStatus {
	const service = isRecord(result.service) ? result.service : {};
	const runtime = isRecord(service.runtime) ? service.runtime : {};
	const rpc = isRecord(result.rpc) ? result.rpc : {};
	const rawPid = runtime.pid;

	return {
		serviceLoaded: service.loaded === true,
		runtimeStatus: typeof runtime.status === "string" ? runtime.status : null,
		runtimePid: typeof rawPid === "number" && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null,
		rpcOk: rpc.ok === true,
	};
}

function isHealthyOpenClawGatewayStatus(
	status: OpenClawGatewayStatus | null,
): status is OpenClawGatewayStatus & { runtimePid: number } {
	return (
		status?.serviceLoaded === true &&
		status.runtimeStatus === "running" &&
		typeof status.runtimePid === "number" &&
		status.rpcOk
	);
}

async function waitForOpenClawGatewayReload(
	statusBeforeInstall: OpenClawGatewayStatus & { runtimePid: number },
	notes: string[],
): Promise<void> {
	const timeoutMs = readPositiveIntegerEnv(
		"TAP_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS",
		DEFAULT_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS,
	);
	const pollMs = readPositiveIntegerEnv(
		"TAP_OPENCLAW_GATEWAY_WAIT_POLL_MS",
		DEFAULT_OPENCLAW_GATEWAY_WAIT_POLL_MS,
	);
	const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
	let lastStatus: OpenClawGatewayStatus | null = statusBeforeInstall;

	notes.push("Detected a running OpenClaw Gateway and waiting for the plugin reload to finish.");

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await sleep(pollMs);
		lastStatus = await readOpenClawGatewayStatus();
		if (
			isHealthyOpenClawGatewayStatus(lastStatus) &&
			lastStatus.runtimePid !== statusBeforeInstall.runtimePid
		) {
			notes.push(
				`Waited for the OpenClaw Gateway to reload the TAP plugin (pid ${statusBeforeInstall.runtimePid} -> ${lastStatus.runtimePid}).`,
			);
			return;
		}
	}

	notes.push(
		`Warning: OpenClaw installed the TAP plugin, but the running Gateway did not reload within ${timeoutMs}ms. ${describeOpenClawGatewayStatus(lastStatus)} Run \`openclaw gateway restart\` if needed.`,
	);
}

function describeOpenClawGatewayStatus(status: OpenClawGatewayStatus | null): string {
	if (status === null) {
		return "Gateway status could not be read during the reload wait.";
	}
	const parts = [
		`serviceLoaded=${String(status.serviceLoaded)}`,
		`runtimeStatus=${status.runtimeStatus ?? "unknown"}`,
		`runtimePid=${status.runtimePid ?? "unknown"}`,
		`rpcOk=${String(status.rpcOk)}`,
	];
	return `Last observed Gateway status: ${parts.join(", ")}.`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const rawValue = process.env[name];
	if (!rawValue) {
		return fallback;
	}
	const value = Number(rawValue);
	if (!Number.isInteger(value) || value <= 0) {
		return fallback;
	}
	return value;
}

async function execOpenClawCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return await execFileAsync("openclaw", args, {
		env: process.env,
		encoding: "utf8",
	});
}

async function execOpenClawJsonCommand(args: string[]): Promise<Record<string, unknown>> {
	const { stdout } = await execOpenClawCommand(args);
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error(`OpenClaw returned no JSON output for: openclaw ${args.join(" ")}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		const normalizedErr = err instanceof Error ? err : new Error(String(err));
		throw new Error(
			`OpenClaw returned invalid JSON for: openclaw ${args.join(" ")} (${normalizedErr.message})`,
		);
	}

	if (!isRecord(parsed)) {
		throw new Error(`OpenClaw returned an unexpected JSON payload for: openclaw ${args.join(" ")}`);
	}

	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Update cli.ts to remove --source-dir and --skip-skills options**

In `packages/cli/src/cli.ts`, replace the install command block (around lines 26-48). Remove the two `.option()` calls for `--source-dir` and `--skip-skills`. Update the action handler:

```typescript
	// Replace the existing install command block with:
	program
		.command("install")
		.description("Install TAP skills and integrations for detected agent runtimes")
		.option(
			"--runtime <runtimes...>",
			"Install for specific runtimes only (claude, codex, openclaw)",
			[],
		)
		.action(async (cmdOpts: { runtime?: string[] }) => {
			const opts = program.opts<GlobalOptions>();
			const { installCommand } = await import("./commands/install.js");
			await installCommand({ runtimes: cmdOpts.runtime }, opts);
		});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/cli && bun run test -- --testPathPattern install`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: rewrite tap install for npm-based distribution"
```

---

### Task 5: Rewrite install.sh

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Replace install.sh with the thin npm-based version**

```bash
#!/usr/bin/env bash
# Trusted Agents Protocol — installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
set -euo pipefail

info()  { printf '\033[1;34m[tap]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[tap]\033[0m %s\n' "$1" >&2; }
die()   { error "$1"; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 18+ is required. Install it from https://nodejs.org"
  local node_major
  node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  if [[ "$node_major" -lt 18 ]]; then
    die "Node.js 18+ is required (found v$(node --version)). Please upgrade."
  fi
}

# ── Install ───────────────────────────────────────────────────────────────────

main() {
  info "Installing Trusted Agents Protocol..."

  check_node

  info "Installing trusted-agents-cli from npm..."
  npm i -g trusted-agents-cli || die "Failed to install trusted-agents-cli from npm."

  info "Setting up runtimes..."
  tap install || die "tap install failed."

  echo ""
  info "Installation complete!"
  info "Run 'tap --help' to get started."
}

main "$@"
```

- [ ] **Step 2: Commit**

```bash
git add scripts/install.sh
git commit -m "chore: simplify install.sh to npm-based install"
```

---

### Task 6: Create bump-version.sh script

**Files:**
- Create: `scripts/bump-version.sh`

- [ ] **Step 1: Create the version bump script**

Create `scripts/bump-version.sh`:

```bash
#!/usr/bin/env bash
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.2.0
set -euo pipefail

VERSION="${1:?Usage: bump-version.sh <version>}"

# Validate version format (semver without leading v)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format: $VERSION (expected: X.Y.Z or X.Y.Z-prerelease)" >&2
  exit 1
fi

PACKAGES=(
  "packages/core/package.json"
  "packages/cli/package.json"
  "packages/openclaw-plugin/package.json"
)

for pkg in "${PACKAGES[@]}"; do
  if [[ ! -f "$pkg" ]]; then
    echo "Error: $pkg not found" >&2
    exit 1
  fi

  # Use node for reliable JSON manipulation
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('$pkg', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "Updated $pkg to $VERSION"
done

echo ""
echo "All packages bumped to $VERSION. Next steps:"
echo "  git add -A && git commit -m \"chore: bump version to $VERSION\""
echo "  git tag v$VERSION"
echo "  git push && git push --tags"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/bump-version.sh
```

- [ ] **Step 3: Test it**

Run: `./scripts/bump-version.sh 0.1.0`
Expected: All three package.json files report "Updated ... to 0.1.0" (no actual change since they're already 0.1.0).

- [ ] **Step 4: Commit**

```bash
git add scripts/bump-version.sh
git commit -m "chore: add version bump script for unified releases"
```

---

### Task 7: Create release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write
  id-token: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    name: Build & Publish
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile

      - run: bun run lint

      - run: bun run typecheck

      - run: bun run build

      - run: bun run test

      # Validate tag version matches package.json versions
      - name: Validate version
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          for pkg in packages/core/package.json packages/cli/package.json packages/openclaw-plugin/package.json; do
            PKG_VERSION=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('$pkg','utf8')).version)")
            if [[ "$PKG_VERSION" != "$TAG_VERSION" ]]; then
              echo "::error::Version mismatch: $pkg has $PKG_VERSION but tag is v$TAG_VERSION"
              exit 1
            fi
          done
          echo "All packages at version $TAG_VERSION"

      # Copy skills into OpenClaw plugin for npm tarball
      - name: Bundle skills into OpenClaw plugin
        run: |
          rm -rf packages/openclaw-plugin/skills
          mkdir -p packages/openclaw-plugin/skills
          cp -r skills/trusted-agents packages/openclaw-plugin/skills/trusted-agents

      # Verify tarballs before publishing
      - name: Verify tarballs
        run: |
          cd packages/core && bun pm pack --dry-run && cd ../..
          cd packages/cli && bun pm pack --dry-run && cd ../..
          cd packages/openclaw-plugin && bun pm pack --dry-run && cd ../..

      # Configure npm auth
      - name: Configure npm
        run: echo "//registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}" > ~/.npmrc

      # Publish in dependency order: core first, then cli and tap
      # --provenance requires id-token: write permission (set above)
      # Each step checks if version exists before publishing to handle re-runs
      - name: Publish trusted-agents-core
        working-directory: packages/core
        run: |
          if npm view trusted-agents-core@${{ github.ref_name }} version 2>/dev/null; then
            echo "trusted-agents-core@${{ github.ref_name }} already published, skipping"
          else
            bun publish --access public --no-git-checks --provenance
          fi

      - name: Publish trusted-agents-cli
        working-directory: packages/cli
        run: |
          if npm view trusted-agents-cli@${{ github.ref_name }} version 2>/dev/null; then
            echo "trusted-agents-cli@${{ github.ref_name }} already published, skipping"
          else
            bun publish --access public --no-git-checks --provenance
          fi

      - name: Publish trusted-agents-tap
        working-directory: packages/openclaw-plugin
        run: |
          if npm view trusted-agents-tap@${{ github.ref_name }} version 2>/dev/null; then
            echo "trusted-agents-tap@${{ github.ref_name }} already published, skipping"
          else
            bun publish --access public --no-git-checks --provenance
          fi

      # Create GitHub Release with auto-generated notes
      - name: Create GitHub Release
        run: gh release create "$GITHUB_REF_NAME" --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note: The existing `.github/workflows/ci.yml` does NOT need changes. It runs `bun run typecheck` which uses the root `package.json` script (already updated in Task 1 to remove SDK). The `packages/*` workspace glob auto-excludes deleted packages.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered release workflow for npm publishing"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update all SDK references in CLAUDE.md**

Find and update the following sections:

1. **Package boundaries** — Remove `packages/sdk` entry. Update dependency direction to remove `sdk -> core`.

2. **Package Responsibilities** — Remove the `packages/sdk` section entirely.

3. **Skills Layout** — Update canonical location from `packages/sdk/skills/trusted-agents/` to `skills/trusted-agents/`. Update the description of the OpenClaw symlinks to explain the build-time copy approach. Remove references to symlinks.

4. **Read Order For Fast Orientation** — Remove item 8 (`packages/sdk/src/orchestrator.ts`).

5. **If You Change X, Also Check Y: Adding/changing/removing a CLI command** — Update skill path from `packages/sdk/skills/trusted-agents/SKILL.md` to `skills/trusted-agents/SKILL.md`.

6. **If You Change X, Also Check Y: Changing TAP skill/reference semantics** — Update from `packages/sdk/skills/trusted-agents/SKILL.md` to `skills/trusted-agents/SKILL.md`. Replace symlink references with build-time copy description.

- [ ] **Step 2: Run typecheck to verify nothing references sdk**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for sdk deletion and new skill paths"
```

---

### Task 9: Verify end-to-end

**Files:** None (verification only)

- [ ] **Step 1: Full build + test from clean state**

```bash
rm -rf node_modules packages/*/dist packages/openclaw-plugin/skills
bun install
bun run typecheck
bun run build
bun run test
```

Expected: All pass.

- [ ] **Step 2: Verify OpenClaw plugin skills are populated by build**

```bash
ls packages/openclaw-plugin/skills/trusted-agents/SKILL.md
ls packages/openclaw-plugin/skills/trusted-agents/references/permissions-v1.md
```

Expected: Both files exist.

- [ ] **Step 3: Verify tarballs look correct**

```bash
cd packages/core && bun pm pack --dry-run && cd ../..
cd packages/cli && bun pm pack --dry-run && cd ../..
cd packages/openclaw-plugin && bun pm pack --dry-run && cd ../..
```

Expected: Each tarball contains the expected files. Core and CLI have `dist/`. OpenClaw plugin has `dist/`, `skills/`, and `openclaw.plugin.json`. No `node_modules` or source files leak in.

- [ ] **Step 4: Verify lint passes**

```bash
bun run lint
```

Expected: PASS. No lint errors from the changes.

- [ ] **Step 5: Commit any remaining fixes**

If any verification steps revealed issues, fix them and commit:
```bash
git add -A
git commit -m "fix: address issues found during release verification"
```
