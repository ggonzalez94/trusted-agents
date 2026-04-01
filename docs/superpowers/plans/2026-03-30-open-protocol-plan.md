# TAP Open Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform TAP from a product with hardcoded actions into infrastructure with an open app protocol — apps are installable, lazy-loaded, and use the same interface as built-in transfer/scheduling.

**Architecture:** New `packages/core/src/app/` module defines the app interface, registry, and storage. `TapMessagingService.onRequest()` routes `action/request` to the app registry instead of hardcoded parsers. Transfer and scheduling are extracted into `packages/app-transfer/` and `packages/app-scheduling/` as real packages. A new `packages/sdk/` provides `createTapRuntime()` as the public API. CLI and OpenClaw host adapter migrate to use the SDK.

**Tech Stack:** TypeScript (ESM, `.js` extensions), Vitest, Biome (tabs, double quotes), Bun workspaces

**Spec:** `docs/superpowers/specs/2026-03-30-open-protocol-design.md`

---

## File Structure

### New files

```
packages/core/src/app/
├── types.ts              # TapApp, TapActionHandler, TapActionContext, TapActionResult, TapAppStorage
├── registry.ts           # TapAppRegistry — routing table, lazy loading, handler dispatch
├── manifest.ts           # Read/write apps.json manifest
├── storage.ts            # FileAppStorage — per-app key-value store
├── context.ts            # buildActionContext() — constructs TapActionContext from runtime state
└── index.ts              # barrel export

packages/core/test/unit/app/
├── registry.test.ts
├── manifest.test.ts
└── storage.test.ts

packages/sdk/
├── src/
│   ├── index.ts          # public API barrel + re-exports
│   └── runtime.ts        # TapRuntime class, createTapRuntime()
├── test/
│   └── runtime.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts

packages/app-transfer/
├── src/
│   ├── index.ts          # defineTapApp + buildTransferPayload export
│   ├── handler.ts        # transfer request handler
│   ├── parser.ts         # parseTransferActionRequest (moved from core)
│   ├── grants.ts         # transfer grant matching (moved from core)
│   └── types.ts          # TransferActionRequest, TransferActionResponse
├── test/
│   └── handler.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts

packages/app-scheduling/
├── src/
│   ├── index.ts          # defineTapApp + buildSchedulingPayload export
│   ├── handler.ts        # scheduling request handler
│   ├── parser.ts         # parseSchedulingActionRequest (moved from core)
│   ├── grants.ts         # scheduling grant matching (moved from core)
│   ├── calendar-provider.ts  # ICalendarProvider (moved from core)
│   ├── scheduling-handler.ts # SchedulingHandler class (moved from core)
│   └── types.ts          # scheduling types (moved from core)
├── test/
│   └── handler.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Modified files

```
packages/core/src/runtime/service.ts      # Replace action dispatch with app registry routing
packages/core/src/runtime/default-context.ts  # Add app registry to TapRuntimeContext
packages/core/src/index.ts                # Add app/ barrel export
packages/core/package.json                # No changes needed (single . export stays)

packages/cli/src/cli.ts                   # Add `tap app` subcommand group
packages/cli/src/lib/context.ts           # Migrate to use SDK (later task)
packages/cli/src/lib/tap-service.ts       # Migrate to use SDK (later task)
packages/cli/package.json                 # Add @trustedagents/sdk dependency

packages/openclaw-plugin/src/registry.ts  # Migrate to use SDK (later task)
packages/openclaw-plugin/package.json     # Add @trustedagents/sdk dependency

package.json (root)                       # Add new workspace packages
vitest.config.ts (root)                   # Already uses projects: ["packages/*"], picks up new packages automatically
```

---

## Task 1: TAP App Interface Types

Define the core types that every TAP app depends on. These types live in core because both the SDK and apps import them.

**Files:**
- Create: `packages/core/src/app/types.ts`
- Create: `packages/core/src/app/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create the app types module**

```ts
// packages/core/src/app/types.ts

import type { Contact, PermissionGrant } from "../trust/types.js";
import type { TrustedAgentsConfig } from "../config/types.js";

// ── Read-only contact view for apps ──

export type ReadonlyContact = Readonly<Contact>;

// ── App-scoped storage ──

export interface TapAppStorage {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix?: string): Promise<Record<string, unknown>>;
}

// ── Payment primitives ──

export interface PaymentRequestParams {
	asset: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

export interface TransferExecuteParams {
	asset: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

// ── App event ──

export interface TapAppEvent {
	type: string;
	summary: string;
	data?: Record<string, unknown>;
}

// ── Action context (what apps receive) ──

export interface TapActionContext {
	self: {
		agentId: number;
		chain: string;
		address: `0x${string}`;
	};
	peer: {
		contact: ReadonlyContact;
		grantsFromPeer: PermissionGrant[];
		grantsToPeer: PermissionGrant[];
	};
	payload: Record<string, unknown>;
	text?: string;
	messaging: {
		reply(text: string): Promise<void>;
		send(peerId: number, text: string): Promise<void>;
	};
	payments: {
		request(params: PaymentRequestParams): Promise<{ requestId: string }>;
		execute(params: TransferExecuteParams): Promise<{ txHash: `0x${string}` }>;
	};
	storage: TapAppStorage;
	events: {
		emit(event: TapAppEvent): void;
	};
	log: {
		append(entry: { text: string; direction: "inbound" | "outbound" }): Promise<void>;
	};
}

// ── Action result ──

export interface TapActionResult {
	success: boolean;
	data?: Record<string, unknown>;
	error?: { code: string; message: string };
}

// ── Action handler ──

export interface TapActionHandler {
	inputSchema?: Record<string, unknown>;
	handler: (ctx: TapActionContext) => Promise<TapActionResult>;
}

// ── App definition ──

export interface TapApp {
	id: string;
	name: string;
	version: string;
	actions: Record<string, TapActionHandler>;
	grantScopes?: string[];
}

// ── Helper to define an app with type checking ──

export function defineTapApp(app: TapApp): TapApp {
	return app;
}
```

- [ ] **Step 2: Create the barrel export**

```ts
// packages/core/src/app/index.ts

export {
	type TapApp,
	type TapActionHandler,
	type TapActionContext,
	type TapActionResult,
	type TapAppStorage,
	type TapAppEvent,
	type ReadonlyContact,
	type PaymentRequestParams,
	type TransferExecuteParams,
	defineTapApp,
} from "./types.js";
```

- [ ] **Step 3: Add app module to core barrel**

In `packages/core/src/index.ts`, add:

```ts
export * from "./app/index.js";
```

- [ ] **Step 4: Run typecheck to verify**

Run: `cd packages/core && bun run typecheck`
Expected: PASS — no type errors

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/app/
git commit -m "feat(core): add TAP app interface types

Defines TapApp, TapActionContext, TapActionResult, TapAppStorage,
and all supporting types for the open protocol architecture."
```

---

## Task 2: App-Scoped File Storage

Implement `FileAppStorage` — a per-app key-value store backed by JSON files in `<dataDir>/apps/<appId>/state.json`. Follows the same atomic write pattern as `FileTrustStore`.

**Files:**
- Create: `packages/core/src/app/storage.ts`
- Create: `packages/core/test/unit/app/storage.test.ts`
- Modify: `packages/core/src/app/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/app/storage.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileAppStorage } from "../../../src/app/storage.js";

describe("FileAppStorage", () => {
	let tmpDir: string;
	let storage: FileAppStorage;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-app-storage-"));
		storage = new FileAppStorage(tmpDir, "test-app");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined for missing keys", async () => {
		expect(await storage.get("missing")).toBeUndefined();
	});

	it("sets and gets a value", async () => {
		await storage.set("foo", { bar: 42 });
		expect(await storage.get("foo")).toEqual({ bar: 42 });
	});

	it("overwrites existing values", async () => {
		await storage.set("foo", 1);
		await storage.set("foo", 2);
		expect(await storage.get("foo")).toBe(2);
	});

	it("deletes a value", async () => {
		await storage.set("foo", "bar");
		await storage.delete("foo");
		expect(await storage.get("foo")).toBeUndefined();
	});

	it("lists all keys", async () => {
		await storage.set("a", 1);
		await storage.set("b", 2);
		await storage.set("c", 3);
		const all = await storage.list();
		expect(all).toEqual({ a: 1, b: 2, c: 3 });
	});

	it("lists keys with prefix filter", async () => {
		await storage.set("bet/1", { id: 1 });
		await storage.set("bet/2", { id: 2 });
		await storage.set("other", "x");
		const bets = await storage.list("bet/");
		expect(bets).toEqual({ "bet/1": { id: 1 }, "bet/2": { id: 2 } });
	});

	it("persists across instances", async () => {
		await storage.set("persistent", true);
		const storage2 = new FileAppStorage(tmpDir, "test-app");
		expect(await storage2.get("persistent")).toBe(true);
	});

	it("isolates different app IDs", async () => {
		const other = new FileAppStorage(tmpDir, "other-app");
		await storage.set("key", "app1");
		await other.set("key", "app2");
		expect(await storage.get("key")).toBe("app1");
		expect(await other.get("key")).toBe("app2");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/unit/app/storage.test.ts`
Expected: FAIL — `Cannot find module '../../../src/app/storage.js'`

- [ ] **Step 3: Implement FileAppStorage**

```ts
// packages/core/src/app/storage.ts

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { TapAppStorage } from "./types.js";

export class FileAppStorage implements TapAppStorage {
	private readonly filePath: string;

	constructor(dataDir: string, appId: string) {
		this.filePath = join(dataDir, "apps", appId, "state.json");
	}

	async get(key: string): Promise<unknown | undefined> {
		const data = await this.load();
		return data[key];
	}

	async set(key: string, value: unknown): Promise<void> {
		const data = await this.load();
		data[key] = value;
		await this.save(data);
	}

	async delete(key: string): Promise<void> {
		const data = await this.load();
		delete data[key];
		await this.save(data);
	}

	async list(prefix?: string): Promise<Record<string, unknown>> {
		const data = await this.load();
		if (!prefix) return { ...data };
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			if (k.startsWith(prefix)) {
				result[k] = v;
			}
		}
		return result;
	}

	private async load(): Promise<Record<string, unknown>> {
		try {
			const content = await readFile(this.filePath, "utf-8");
			return JSON.parse(content) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private async save(data: Record<string, unknown>): Promise<void> {
		const dir = dirname(this.filePath);
		await mkdir(dir, { recursive: true });
		const tmpPath = join(dir, `.state-${randomUUID()}.tmp`);
		await writeFile(tmpPath, JSON.stringify(data, null, "\t"), { mode: 0o600 });
		await rename(tmpPath, this.filePath);
	}
}
```

- [ ] **Step 4: Export from barrel**

Add to `packages/core/src/app/index.ts`:

```ts
export { FileAppStorage } from "./storage.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/unit/app/storage.test.ts`
Expected: PASS — all 8 tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/app/storage.ts packages/core/src/app/index.ts packages/core/test/unit/app/storage.test.ts
git commit -m "feat(core): add FileAppStorage for per-app key-value state

Atomic JSON file storage scoped per app ID, stored at
<dataDir>/apps/<appId>/state.json."
```

---

## Task 3: App Manifest

Read/write the `apps.json` manifest file. The manifest maps app IDs to their npm package entry points.

**Files:**
- Create: `packages/core/src/app/manifest.ts`
- Create: `packages/core/test/unit/app/manifest.test.ts`
- Modify: `packages/core/src/app/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/app/manifest.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadAppManifest,
	saveAppManifest,
	addAppToManifest,
	removeAppFromManifest,
	buildRoutingTable,
	type AppManifest,
	type AppManifestEntry,
} from "../../../src/app/manifest.js";

describe("AppManifest", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-manifest-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns empty manifest when file does not exist", async () => {
		const manifest = await loadAppManifest(tmpDir);
		expect(manifest.apps).toEqual({});
	});

	it("saves and loads a manifest", async () => {
		const manifest: AppManifest = {
			apps: {
				transfer: {
					package: "@trustedagents/app-transfer",
					entryPoint: "@trustedagents/app-transfer",
					installedAt: "2026-03-30T00:00:00.000Z",
					status: "active",
				},
			},
		};
		await saveAppManifest(tmpDir, manifest);
		const loaded = await loadAppManifest(tmpDir);
		expect(loaded).toEqual(manifest);
	});

	it("adds an app entry", async () => {
		const entry: AppManifestEntry = {
			package: "tap-app-betting",
			entryPoint: "tap-app-betting",
			installedAt: "2026-03-30T00:00:00.000Z",
			status: "active",
		};
		await addAppToManifest(tmpDir, "betting", entry);
		const manifest = await loadAppManifest(tmpDir);
		expect(manifest.apps.betting).toEqual(entry);
	});

	it("removes an app entry", async () => {
		const entry: AppManifestEntry = {
			package: "tap-app-betting",
			entryPoint: "tap-app-betting",
			installedAt: "2026-03-30T00:00:00.000Z",
			status: "active",
		};
		await addAppToManifest(tmpDir, "betting", entry);
		await removeAppFromManifest(tmpDir, "betting");
		const manifest = await loadAppManifest(tmpDir);
		expect(manifest.apps.betting).toBeUndefined();
	});

	it("builds routing table from manifest with loaded apps", () => {
		const manifest: AppManifest = {
			apps: {
				transfer: {
					package: "@trustedagents/app-transfer",
					entryPoint: "@trustedagents/app-transfer",
					installedAt: "2026-03-30T00:00:00.000Z",
					status: "active",
				},
			},
		};
		// buildRoutingTable requires loaded app definitions — tested in registry
		const table = buildRoutingTable(manifest);
		expect(table.size).toBe(1);
		expect(table.get("transfer")).toEqual({
			appId: "transfer",
			entryPoint: "@trustedagents/app-transfer",
		});
	});

	it("skips inactive apps in routing table", () => {
		const manifest: AppManifest = {
			apps: {
				betting: {
					package: "tap-app-betting",
					entryPoint: "tap-app-betting",
					installedAt: "2026-03-30T00:00:00.000Z",
					status: "inactive",
				},
			},
		};
		const table = buildRoutingTable(manifest);
		expect(table.size).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/unit/app/manifest.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement manifest module**

```ts
// packages/core/src/app/manifest.ts

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AppManifestEntry {
	package: string;
	entryPoint: string;
	installedAt: string;
	status: "active" | "inactive";
}

export interface AppManifest {
	apps: Record<string, AppManifestEntry>;
}

export interface RoutingEntry {
	appId: string;
	entryPoint: string;
}

function manifestPath(dataDir: string): string {
	return join(dataDir, "apps.json");
}

export async function loadAppManifest(dataDir: string): Promise<AppManifest> {
	try {
		const content = await readFile(manifestPath(dataDir), "utf-8");
		return JSON.parse(content) as AppManifest;
	} catch {
		return { apps: {} };
	}
}

export async function saveAppManifest(
	dataDir: string,
	manifest: AppManifest,
): Promise<void> {
	const filePath = manifestPath(dataDir);
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmpPath = join(dir, `.apps-${randomUUID()}.tmp`);
	await writeFile(tmpPath, JSON.stringify(manifest, null, "\t"), { mode: 0o600 });
	await rename(tmpPath, filePath);
}

export async function addAppToManifest(
	dataDir: string,
	appId: string,
	entry: AppManifestEntry,
): Promise<void> {
	const manifest = await loadAppManifest(dataDir);
	manifest.apps[appId] = entry;
	await saveAppManifest(dataDir, manifest);
}

export async function removeAppFromManifest(
	dataDir: string,
	appId: string,
): Promise<void> {
	const manifest = await loadAppManifest(dataDir);
	delete manifest.apps[appId];
	await saveAppManifest(dataDir, manifest);
}

export function buildRoutingTable(
	manifest: AppManifest,
): Map<string, RoutingEntry> {
	const table = new Map<string, RoutingEntry>();
	for (const [appId, entry] of Object.entries(manifest.apps)) {
		if (entry.status !== "active") continue;
		table.set(appId, { appId, entryPoint: entry.entryPoint });
	}
	return table;
}
```

- [ ] **Step 4: Export from barrel**

Add to `packages/core/src/app/index.ts`:

```ts
export {
	type AppManifest,
	type AppManifestEntry,
	type RoutingEntry,
	loadAppManifest,
	saveAppManifest,
	addAppToManifest,
	removeAppFromManifest,
	buildRoutingTable,
} from "./manifest.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/unit/app/manifest.test.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/app/manifest.ts packages/core/src/app/index.ts packages/core/test/unit/app/manifest.test.ts
git commit -m "feat(core): add app manifest read/write and routing table builder

Manages apps.json manifest with add/remove operations and builds
action-type to app-id routing table for the dispatch layer."
```

---

## Task 4: App Registry

The registry loads apps lazily, manages the routing table (action type -> app), and dispatches inbound action requests to the correct handler.

**Files:**
- Create: `packages/core/src/app/registry.ts`
- Create: `packages/core/src/app/context.ts`
- Create: `packages/core/test/unit/app/registry.test.ts`
- Modify: `packages/core/src/app/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/app/registry.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	TapAppRegistry,
	type TapAppRegistryOptions,
} from "../../../src/app/registry.js";
import {
	addAppToManifest,
	type AppManifestEntry,
} from "../../../src/app/manifest.js";
import { defineTapApp, type TapActionContext } from "../../../src/app/types.js";

// A simple in-memory test app
const testApp = defineTapApp({
	id: "test-betting",
	name: "Test Betting",
	version: "1.0.0",
	actions: {
		"bet/propose": {
			handler: async (ctx: TapActionContext) => ({
				success: true,
				data: { accepted: true, terms: ctx.payload.terms },
			}),
		},
		"bet/accept": {
			handler: async (_ctx: TapActionContext) => ({
				success: true,
				data: { confirmed: true },
			}),
		},
	},
	grantScopes: ["bet/propose"],
});

describe("TapAppRegistry", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-registry-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("reports no handler for unknown action types", async () => {
		const registry = new TapAppRegistry(tmpDir);
		await registry.loadManifest();
		expect(registry.hasHandler("bet/propose")).toBe(false);
	});

	it("registers an app and routes to its handler", async () => {
		const registry = new TapAppRegistry(tmpDir);
		registry.registerApp(testApp);
		expect(registry.hasHandler("bet/propose")).toBe(true);
		expect(registry.hasHandler("bet/accept")).toBe(true);
		expect(registry.hasHandler("unknown/action")).toBe(false);
	});

	it("returns the app for an action type", () => {
		const registry = new TapAppRegistry(tmpDir);
		registry.registerApp(testApp);
		const app = registry.getAppForAction("bet/propose");
		expect(app).toBeDefined();
		expect(app!.id).toBe("test-betting");
	});

	it("rejects duplicate action type registrations", () => {
		const registry = new TapAppRegistry(tmpDir);
		registry.registerApp(testApp);
		const duplicate = defineTapApp({
			id: "duplicate",
			name: "Duplicate",
			version: "1.0.0",
			actions: {
				"bet/propose": {
					handler: async () => ({ success: true }),
				},
			},
		});
		expect(() => registry.registerApp(duplicate)).toThrow(
			/already registered/,
		);
	});

	it("unregisters an app", () => {
		const registry = new TapAppRegistry(tmpDir);
		registry.registerApp(testApp);
		registry.unregisterApp("test-betting");
		expect(registry.hasHandler("bet/propose")).toBe(false);
	});

	it("lists registered apps", () => {
		const registry = new TapAppRegistry(tmpDir);
		registry.registerApp(testApp);
		const apps = registry.listApps();
		expect(apps).toHaveLength(1);
		expect(apps[0].id).toBe("test-betting");
		expect(apps[0].actionTypes).toEqual(["bet/propose", "bet/accept"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/unit/app/registry.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement TapAppRegistry**

```ts
// packages/core/src/app/registry.ts

import type { TapApp, TapActionHandler } from "./types.js";
import { loadAppManifest, type AppManifest } from "./manifest.js";

export interface RegisteredAppInfo {
	id: string;
	name: string;
	version: string;
	actionTypes: string[];
	grantScopes: string[];
}

export interface TapAppRegistryOptions {
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

export class TapAppRegistry {
	private readonly dataDir: string;
	private readonly apps = new Map<string, TapApp>();
	private readonly actionMap = new Map<string, string>(); // action type -> app ID
	private readonly loadedModules = new Map<string, TapApp>(); // entry point -> loaded app
	private manifest: AppManifest = { apps: {} };
	private readonly log: (level: "info" | "warn" | "error", message: string) => void;

	constructor(dataDir: string, options?: TapAppRegistryOptions) {
		this.dataDir = dataDir;
		this.log = options?.log ?? (() => {});
	}

	async loadManifest(): Promise<void> {
		this.manifest = await loadAppManifest(this.dataDir);
	}

	registerApp(app: TapApp): void {
		for (const actionType of Object.keys(app.actions)) {
			const existing = this.actionMap.get(actionType);
			if (existing && existing !== app.id) {
				throw new Error(
					`Action type "${actionType}" is already registered by app "${existing}"`,
				);
			}
		}
		this.apps.set(app.id, app);
		for (const actionType of Object.keys(app.actions)) {
			this.actionMap.set(actionType, app.id);
		}
		this.log("info", `Registered app "${app.id}" with actions: ${Object.keys(app.actions).join(", ")}`);
	}

	unregisterApp(appId: string): void {
		const app = this.apps.get(appId);
		if (!app) return;
		for (const actionType of Object.keys(app.actions)) {
			this.actionMap.delete(actionType);
		}
		this.apps.delete(appId);
		this.log("info", `Unregistered app "${appId}"`);
	}

	hasHandler(actionType: string): boolean {
		return this.actionMap.has(actionType);
	}

	getAppForAction(actionType: string): TapApp | undefined {
		const appId = this.actionMap.get(actionType);
		if (!appId) return undefined;
		return this.apps.get(appId);
	}

	getHandler(actionType: string): TapActionHandler | undefined {
		const app = this.getAppForAction(actionType);
		if (!app) return undefined;
		return app.actions[actionType];
	}

	listApps(): RegisteredAppInfo[] {
		return Array.from(this.apps.values()).map((app) => ({
			id: app.id,
			name: app.name,
			version: app.version,
			actionTypes: Object.keys(app.actions),
			grantScopes: app.grantScopes ?? [],
		}));
	}

	async loadAppFromManifest(appId: string): Promise<TapApp | undefined> {
		const entry = this.manifest.apps[appId];
		if (!entry || entry.status !== "active") return undefined;

		const cached = this.loadedModules.get(entry.entryPoint);
		if (cached) return cached;

		try {
			const mod = await import(entry.entryPoint);
			const app: TapApp = mod.default ?? mod;
			if (!app.id || !app.actions || typeof app.actions !== "object") {
				this.log("error", `App "${appId}" from "${entry.entryPoint}" has invalid TapApp shape`);
				return undefined;
			}
			this.loadedModules.set(entry.entryPoint, app);
			return app;
		} catch (err) {
			this.log(
				"error",
				`Failed to load app "${appId}" from "${entry.entryPoint}": ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}
	}

	async resolveHandler(
		actionType: string,
	): Promise<{ app: TapApp; handler: TapActionHandler } | undefined> {
		// Check already-registered apps first
		const handler = this.getHandler(actionType);
		if (handler) {
			const app = this.getAppForAction(actionType)!;
			return { app, handler };
		}

		// Try lazy-loading from manifest
		for (const [appId, entry] of Object.entries(this.manifest.apps)) {
			if (entry.status !== "active") continue;
			if (this.apps.has(appId)) continue; // already loaded

			const app = await this.loadAppFromManifest(appId);
			if (!app) continue;

			// Register it so future lookups are instant
			try {
				this.registerApp(app);
			} catch {
				// Action type conflict — skip this app
				continue;
			}

			if (app.actions[actionType]) {
				return { app, handler: app.actions[actionType] };
			}
		}

		return undefined;
	}
}
```

- [ ] **Step 4: Export from barrel**

Add to `packages/core/src/app/index.ts`:

```ts
export {
	TapAppRegistry,
	type TapAppRegistryOptions,
	type RegisteredAppInfo,
} from "./registry.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/unit/app/registry.test.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/app/registry.ts packages/core/src/app/index.ts packages/core/test/unit/app/registry.test.ts
git commit -m "feat(core): add TapAppRegistry with lazy loading and action routing

Routes action types to app handlers. Supports both direct registration
and lazy loading from the apps.json manifest."
```

---

## Task 5: Open the Action Dispatch in TapMessagingService

Replace the hardcoded `action/request` dispatch in `onRequest()` with routing through `TapAppRegistry`. Unknown action types return a structured error instead of throwing.

**Files:**
- Modify: `packages/core/src/runtime/default-context.ts` (add `appRegistry` to context)
- Modify: `packages/core/src/runtime/service.ts` (replace dispatch, add registry field)
- Create: `packages/core/src/app/context.ts` (build `TapActionContext` from runtime state)
- Modify: `packages/core/test/unit/runtime/service.test.ts` (update tests for new dispatch)

This task is the critical pivot. It changes the existing hardcoded dispatch to route through the app registry. Transfer and scheduling handlers are still registered directly (not yet extracted to separate packages) — they become the first "built-in apps" within core itself.

- [ ] **Step 1: Add appRegistry to TapRuntimeContext**

In `packages/core/src/runtime/default-context.ts`, add to the `TapRuntimeContext` interface:

```ts
import { TapAppRegistry } from "../app/registry.js";
```

Add `appRegistry: TapAppRegistry` field to the interface and construct it in `buildDefaultTapRuntimeContext`:

```ts
const appRegistry = new TapAppRegistry(config.dataDir, {
	log: (level, message) => options?.log?.(level, message),
});
```

Include it in the returned context object.

- [ ] **Step 2: Create buildActionContext**

```ts
// packages/core/src/app/context.ts

import type {
	TapActionContext,
	TapApp,
	PaymentRequestParams,
	TransferExecuteParams,
	TapAppEvent,
} from "./types.js";
import { FileAppStorage } from "./storage.js";
import type { Contact, PermissionGrant } from "../trust/types.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import { findActiveGrantsByScope } from "../runtime/grants.js";

export interface BuildActionContextDeps {
	config: TrustedAgentsConfig;
	contact: Contact;
	app: TapApp;
	payload: Record<string, unknown>;
	text?: string;
	sendMessage: (peerId: number, text: string) => Promise<void>;
	requestFunds: (params: PaymentRequestParams) => Promise<{ requestId: string }>;
	executeTransfer: (params: TransferExecuteParams) => Promise<{ txHash: `0x${string}` }>;
	emitEvent?: (payload: Record<string, unknown>) => void;
	appendConversationLog: (entry: { text: string; direction: "inbound" | "outbound" }) => Promise<void>;
}

export function buildActionContext(deps: BuildActionContextDeps): TapActionContext {
	const appScopes = deps.app.grantScopes ?? [];
	const grantedByPeer = deps.contact.permissions?.grantedByPeer?.grants ?? [];
	const grantedByMe = deps.contact.permissions?.grantedByMe?.grants ?? [];

	const grantsFromPeer: PermissionGrant[] = [];
	const grantsToPeer: PermissionGrant[] = [];

	for (const scope of appScopes) {
		grantsFromPeer.push(...findActiveGrantsByScope(grantedByPeer, scope));
		grantsToPeer.push(...findActiveGrantsByScope(grantedByMe, scope));
	}

	const storage = new FileAppStorage(deps.config.dataDir, deps.app.id);

	return {
		self: {
			agentId: deps.config.agentId,
			chain: deps.config.chain,
			address: deps.config.agentAddress as `0x${string}`,
		},
		peer: {
			contact: Object.freeze({ ...deps.contact }),
			grantsFromPeer,
			grantsToPeer,
		},
		payload: deps.payload,
		text: deps.text,
		messaging: {
			reply: (text: string) => deps.sendMessage(deps.contact.peerAgentId, text),
			send: deps.sendMessage,
		},
		payments: {
			request: deps.requestFunds,
			execute: deps.executeTransfer,
		},
		storage,
		events: {
			emit: (event: TapAppEvent) => {
				deps.emitEvent?.({
					type: `app:${deps.app.id}:${event.type}`,
					summary: event.summary,
					appId: deps.app.id,
					...event.data,
				});
			},
		},
		log: {
			append: deps.appendConversationLog,
		},
	};
}
```

- [ ] **Step 3: Export context builder from barrel**

Add to `packages/core/src/app/index.ts`:

```ts
export { buildActionContext, type BuildActionContextDeps } from "./context.js";
```

- [ ] **Step 4: Modify onRequest() in service.ts to route through app registry**

In `packages/core/src/runtime/service.ts`, the current `action/request` dispatch (approximately lines 1579-1658) needs to change. After the `MESSAGE_SEND` handling block, replace the remaining `action/request` dispatch with:

1. Extract `data` from the message parts (reuse the existing `extractMessageData` pattern from `actions.ts`)
2. Determine the action type from `data.type` (string)
3. Call `this.context.appRegistry.resolveHandler(actionType)`
4. If no handler found: build and send `action/result` with `{ error: { code: "UNSUPPORTED_ACTION" } }`, mark completed, return
5. If handler found: call `buildActionContext()` and invoke the handler
6. Send the `TapActionResult` back as an `action/result` message

Add a new public method `sendActionRequest(peer, actionType, payload)` to `TapMessagingService`. This builds and sends an `action/request` message with arbitrary payload, using the existing `buildOutgoingActionRequest()` utility. The SDK's `runtime.sendAction()` delegates to this method. Signature:

```ts
async sendActionRequest(
	peer: { agentId: number } | { connectionId: string },
	actionType: string,
	payload: Record<string, unknown>,
	text?: string,
): Promise<TapSendMessageResult>
```

This method: resolves the contact, builds the outgoing action request using `buildOutgoingActionRequest(contact, text ?? "", { type: actionType, ...payload }, actionType)`, sends it via transport, logs the conversation, and records in the request journal.

The existing `parseTransferActionRequest`, `parseSchedulingActionRequest`, and `parsePermissionGrantRequest` calls are removed from `onRequest`. Instead, transfer and scheduling are registered as apps on the registry during `TapMessagingService` construction.

**Important:** For now, register the existing transfer/scheduling logic as inline apps during construction. This keeps them working while we extract them to separate packages in Tasks 6-7. The inline registration looks like:

```ts
// In TapMessagingService constructor, after registry is available:
this.context.appRegistry.registerApp(defineTapApp({
	id: "transfer",
	name: "Transfer",
	version: "1.0.0",
	actions: {
		"transfer/request": {
			handler: async (ctx) => {
				// Delegate to existing processTransferRequest logic
				// This is a temporary bridge until Task 6 extracts it
			},
		},
	},
	grantScopes: ["transfer/request"],
}));
```

Do the same for scheduling and permission grant requests.

- [ ] **Step 5: Update service tests**

Modify `packages/core/test/unit/runtime/service.test.ts` to account for the new dispatch flow. Existing tests that send `action/request` with transfer/scheduling payloads should still pass since the built-in apps handle them. Add a new test for the `UNSUPPORTED_ACTION` error response:

```ts
it("returns UNSUPPORTED_ACTION for unknown action types", async () => {
	// Send an action/request with { type: "unknown/action" }
	// Expect the response to be action/result with error.code === "UNSUPPORTED_ACTION"
});
```

- [ ] **Step 6: Run all core tests**

Run: `bun run test`
Expected: All existing tests pass. New unsupported-action test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/app/ packages/core/src/runtime/
git commit -m "feat(core): route action/request through app registry

Replaces hardcoded action dispatch in TapMessagingService.onRequest()
with TapAppRegistry routing. Unknown action types return a structured
UNSUPPORTED_ACTION error instead of throwing. Transfer and scheduling
are temporarily registered as inline apps."
```

---

## Task 6: Extract Transfer App

Move transfer request handling from `service.ts` into `packages/app-transfer/` as a real TAP app package.

**Files:**
- Create: `packages/app-transfer/package.json`
- Create: `packages/app-transfer/tsconfig.json`
- Create: `packages/app-transfer/vitest.config.ts`
- Create: `packages/app-transfer/src/index.ts`
- Create: `packages/app-transfer/src/handler.ts`
- Create: `packages/app-transfer/src/parser.ts`
- Create: `packages/app-transfer/src/grants.ts`
- Create: `packages/app-transfer/src/types.ts`
- Create: `packages/app-transfer/test/handler.test.ts`
- Modify: `packages/core/src/runtime/service.ts` (remove inline transfer app, register from package)
- Modify: `package.json` (root — add workspace)

- [ ] **Step 1: Create package scaffolding**

```json
// packages/app-transfer/package.json
{
	"name": "@trustedagents/app-transfer",
	"version": "0.1.0",
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"import": "./dist/index.js",
			"types": "./dist/index.d.ts"
		}
	},
	"scripts": {
		"build": "tsc -b",
		"typecheck": "tsc --noEmit"
	},
	"dependencies": {
		"trusted-agents-core": "workspace:*"
	}
}
```

```json
// packages/app-transfer/tsconfig.json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "./dist",
		"rootDir": "./src",
		"composite": true
	},
	"include": ["src/**/*.ts"],
	"exclude": ["node_modules", "dist", "test"]
}
```

```ts
// packages/app-transfer/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 10000,
	},
	resolve: {
		alias: {
			"trusted-agents-core": "../core/src/index.ts",
		},
	},
});
```

- [ ] **Step 2: Move transfer types**

Move `TransferActionRequest` and `TransferActionResponse` type definitions from `packages/core/src/runtime/actions.ts` to `packages/app-transfer/src/types.ts`. Keep the core definitions as re-exports from the app package for backward compatibility until all consumers are migrated.

- [ ] **Step 3: Move transfer parser**

Move `parseTransferActionRequest`, `parseTransferActionResponse`, `buildTransferRequestText`, and `buildTransferResponseText` from `packages/core/src/runtime/actions.ts` to `packages/app-transfer/src/parser.ts`. These functions parse `action/request` messages with `type: "transfer/request"`.

- [ ] **Step 4: Move transfer grant matching**

Move `findApplicableTransferGrants` and `matchesTransferGrantRequest` (the transfer-specific grant matching from `service.ts` ~lines 3290-3342) to `packages/app-transfer/src/grants.ts`.

- [ ] **Step 5: Implement the transfer app handler**

```ts
// packages/app-transfer/src/handler.ts

import { type TapActionContext, type TapActionResult } from "trusted-agents-core";
import { matchesTransferGrantRequest } from "./grants.js";

export async function handleTransferRequest(
	ctx: TapActionContext,
): Promise<TapActionResult> {
	const { payload, peer } = ctx;

	// Validate required fields
	const asset = payload.asset as string | undefined;
	const amount = payload.amount as string | undefined;
	const chain = payload.chain as string | undefined;
	const toAddress = payload.toAddress as `0x${string}` | undefined;

	if (!asset || !amount || !chain || !toAddress) {
		return {
			success: false,
			error: { code: "INVALID_PAYLOAD", message: "Missing required transfer fields" },
		};
	}

	// Check grants
	const matchingGrant = peer.grantsFromPeer.find((grant) =>
		matchesTransferGrantRequest(grant, { asset, amount, chain, toAddress }),
	);

	if (!matchingGrant) {
		return {
			success: false,
			error: { code: "NO_MATCHING_GRANT", message: "No grant covers this transfer request" },
		};
	}

	// Execute the transfer
	try {
		const { txHash } = await ctx.payments.execute({ asset, amount, chain, toAddress });
		await ctx.log.append({
			text: `Executed transfer: ${amount} ${asset} to ${toAddress} (tx: ${txHash})`,
			direction: "outbound",
		});
		return {
			success: true,
			data: { type: "transfer/response", txHash, asset, amount, chain, toAddress },
		};
	} catch (err) {
		return {
			success: false,
			error: {
				code: "TRANSFER_FAILED",
				message: err instanceof Error ? err.message : "Transfer execution failed",
			},
		};
	}
}
```

- [ ] **Step 6: Create the app entry point**

```ts
// packages/app-transfer/src/index.ts

import { defineTapApp } from "trusted-agents-core";
import { handleTransferRequest } from "./handler.js";

export { type TransferActionRequest, type TransferActionResponse } from "./types.js";
export { buildTransferRequestText, buildTransferResponseText } from "./parser.js";

export function buildTransferPayload(params: {
	asset: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}): Record<string, unknown> {
	return {
		type: "transfer/request",
		...params,
	};
}

export default defineTapApp({
	id: "transfer",
	name: "Transfer",
	version: "1.0.0",
	actions: {
		"transfer/request": {
			handler: handleTransferRequest,
		},
	},
	grantScopes: ["transfer/request"],
});
```

- [ ] **Step 7: Write handler test**

Write `packages/app-transfer/test/handler.test.ts` with tests that:
- Construct a mock `TapActionContext` with the required primitives
- Test successful transfer execution (matching grant exists)
- Test rejection when no grant matches
- Test rejection when payload is invalid
- Test error handling when `payments.execute` throws

- [ ] **Step 8: Remove inline transfer registration from service.ts**

In `TapMessagingService` constructor, replace the inline transfer app registration with:

```ts
import transferApp from "@trustedagents/app-transfer";
this.context.appRegistry.registerApp(transferApp);
```

**Core must NOT import from app-transfer** (app-transfer depends on core — circular). Instead, remove the inline transfer app registration from the `TapMessagingService` constructor and add `@trustedagents/app-transfer` to the default manifest in `apps.json`. The registry will lazy-load it on first inbound `transfer/request`. Verify that the E2E test still passes with manifest-based loading.

- [ ] **Step 9: Add to root workspace and install**

Add `"packages/app-transfer"` to the `workspaces` array in the root `package.json`. Run `bun install`.

- [ ] **Step 10: Run all tests**

Run: `bun run test`
Expected: All tests pass — existing transfer behavior unchanged, new handler tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/app-transfer/ package.json
git commit -m "feat: extract transfer handling into @trustedagents/app-transfer

First built-in TAP app. Moves transfer request parsing, grant matching,
and handler logic from core service.ts into a standalone package."
```

---

## Task 7: Extract Scheduling App

Same pattern as Task 6 but for scheduling. Move scheduling logic from core into `packages/app-scheduling/`.

**Files:**
- Create: `packages/app-scheduling/package.json`
- Create: `packages/app-scheduling/tsconfig.json`
- Create: `packages/app-scheduling/vitest.config.ts`
- Create: `packages/app-scheduling/src/index.ts`
- Create: `packages/app-scheduling/src/handler.ts`
- Create: `packages/app-scheduling/src/parser.ts` (from `core/src/scheduling/actions.ts`)
- Create: `packages/app-scheduling/src/grants.ts` (from `core/src/scheduling/grants.ts`)
- Create: `packages/app-scheduling/src/types.ts` (from `core/src/scheduling/types.ts`)
- Create: `packages/app-scheduling/src/calendar-provider.ts` (from `core/src/scheduling/calendar-provider.ts`)
- Create: `packages/app-scheduling/src/scheduling-handler.ts` (from `core/src/scheduling/handler.ts`)
- Create: `packages/app-scheduling/test/handler.test.ts`
- Modify: `packages/core/src/runtime/service.ts` (remove inline scheduling app)
- Modify: `package.json` (root — add workspace)

- [ ] **Step 1: Create package scaffolding**

Same pattern as Task 6 Step 1. Package name: `@trustedagents/app-scheduling`. Dependencies: `trusted-agents-core: workspace:*`.

- [ ] **Step 2: Move scheduling types, parser, grants, handler, calendar-provider**

Move the contents of `packages/core/src/scheduling/` into the corresponding files in `packages/app-scheduling/src/`. The scheduling module in core (`packages/core/src/scheduling/`) has 5 files:
- `types.ts` → `packages/app-scheduling/src/types.ts`
- `actions.ts` → `packages/app-scheduling/src/parser.ts`
- `grants.ts` → `packages/app-scheduling/src/grants.ts`
- `handler.ts` → `packages/app-scheduling/src/scheduling-handler.ts`
- `calendar-provider.ts` → `packages/app-scheduling/src/calendar-provider.ts`

Update imports to use `trusted-agents-core` for core types.

- [ ] **Step 3: Implement the scheduling app handler**

`packages/app-scheduling/src/handler.ts` — wraps the existing `SchedulingHandler` class as a TAP app action handler. Similar pattern to the transfer handler: parse the inbound scheduling proposal, evaluate grants, delegate to `SchedulingHandler.evaluateProposal()`.

- [ ] **Step 4: Create the app entry point**

```ts
// packages/app-scheduling/src/index.ts

import { defineTapApp } from "trusted-agents-core";
import { handleSchedulingRequest } from "./handler.js";

export { type SchedulingProposal, type TimeSlot } from "./types.js";
export { SchedulingHandler } from "./scheduling-handler.js";
export { type ICalendarProvider } from "./calendar-provider.js";

export function buildSchedulingPayload(params: {
	title: string;
	durationMinutes: number;
	proposedSlots: Array<{ start: string; end: string }>;
	timezone?: string;
	note?: string;
}): Record<string, unknown> {
	return {
		type: "scheduling/request",
		...params,
	};
}

export default defineTapApp({
	id: "scheduling",
	name: "Scheduling",
	version: "1.0.0",
	actions: {
		"scheduling/request": {
			handler: handleSchedulingRequest,
		},
	},
	grantScopes: ["scheduling/request"],
});
```

- [ ] **Step 5: Move existing scheduling tests**

Move `packages/core/test/scheduling/*.test.ts` to `packages/app-scheduling/test/`. Update import paths.

- [ ] **Step 6: Remove inline scheduling registration from service.ts**

Replace with registration from the package (same approach as Task 6 Step 8).

- [ ] **Step 7: Remove the scheduling module from core**

Delete `packages/core/src/scheduling/` directory. Remove the `export * from "./scheduling/index.js"` line from `packages/core/src/index.ts`. Any core code that previously imported from the scheduling module must now import from `@trustedagents/app-scheduling`.

Note: if core needs any scheduling types for backward compatibility, re-export them from the app package via core's barrel. But prefer clean breaks.

- [ ] **Step 8: Add to root workspace and install**

Add `"packages/app-scheduling"` to root `package.json` workspaces. Run `bun install`.

- [ ] **Step 9: Run all tests**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/app-scheduling/ packages/core/src/scheduling/ packages/core/src/index.ts package.json
git commit -m "feat: extract scheduling into @trustedagents/app-scheduling

Second built-in TAP app. Moves scheduling types, parser, grant matching,
calendar provider, and handler from core into a standalone package."
```

---

## Task 8: SDK Package — createTapRuntime

Build the public SDK package with `createTapRuntime()` as the single entry point for all TAP hosts.

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/vitest.config.ts`
- Create: `packages/sdk/src/index.ts`
- Create: `packages/sdk/src/runtime.ts`
- Create: `packages/sdk/src/installer.ts`
- Create: `packages/sdk/src/types.ts`
- Create: `packages/sdk/test/runtime.test.ts`
- Modify: `package.json` (root — add workspace)

- [ ] **Step 1: Create package scaffolding**

```json
// packages/sdk/package.json
{
	"name": "@trustedagents/sdk",
	"version": "0.1.0",
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"import": "./dist/index.js",
			"types": "./dist/index.d.ts"
		}
	},
	"scripts": {
		"build": "tsc -b",
		"typecheck": "tsc --noEmit"
	},
	"dependencies": {
		"trusted-agents-core": "workspace:*"
	}
}
```

```json
// packages/sdk/tsconfig.json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "./dist",
		"rootDir": "./src",
		"composite": true
	},
	"include": ["src/**/*.ts"],
	"exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 2: Implement TapRuntime class**

```ts
// packages/sdk/src/runtime.ts

import {
	type TrustedAgentsConfig,
	type TapRuntimeContext,
	type TransportProvider,
	type ITrustStore,
	type IConversationLogger,
	type IRequestJournal,
	TapMessagingService,
	type TapServiceHooks,
	loadTrustedAgentConfigFromDataDir,
	buildDefaultTapRuntimeContext,
	OwsSigningProvider,
	type TapAppRegistry,
	type TapApp,
	addAppToManifest,
	removeAppFromManifest,
	type AppManifestEntry,
	type RegisteredAppInfo,
} from "trusted-agents-core";
import { EventEmitter } from "node:events";

export interface CreateTapRuntimeOptions {
	dataDir: string;
	overrides?: {
		trustStore?: ITrustStore;
		conversationLogger?: IConversationLogger;
		requestJournal?: IRequestJournal;
		transport?: TransportProvider;
	};
	hooks?: TapServiceHooks;
}

export class TapRuntime extends EventEmitter {
	private service: TapMessagingService | undefined;
	private context: TapRuntimeContext | undefined;
	private config: TrustedAgentsConfig | undefined;
	private readonly options: CreateTapRuntimeOptions;

	constructor(options: CreateTapRuntimeOptions) {
		super();
		this.options = options;
	}

	async init(): Promise<void> {
		this.config = await loadTrustedAgentConfigFromDataDir(this.options.dataDir);
		const signingProvider = new OwsSigningProvider(
			this.config.ows.wallet,
			this.config.chain,
			this.config.ows.apiKey,
		);
		this.context = await buildDefaultTapRuntimeContext(this.config, {
			signingProvider,
			...this.options.overrides,
		});
		await this.context.appRegistry.loadManifest();

		const hooks: TapServiceHooks = {
			...this.options.hooks,
			emitEvent: (payload) => {
				this.emit("event", payload);
				this.options.hooks?.emitEvent?.(payload);
			},
		};

		this.service = new TapMessagingService(this.context, { hooks });
	}

	async start(): Promise<void> {
		if (!this.service) await this.init();
		await this.service!.start();
	}

	async stop(): Promise<void> {
		await this.service?.stop();
	}

	async syncOnce() {
		return this.requireService().syncOnce();
	}

	async connect(params: { inviteUrl: string }) {
		return this.requireService().connect(params);
	}

	async sendMessage(peerId: number, text: string) {
		return this.requireService().sendMessage({ agentId: peerId }, text);
	}

	async sendAction(peerId: number, actionType: string, payload: Record<string, unknown>, text?: string) {
		return this.requireService().sendActionRequest(
			{ agentId: peerId },
			actionType,
			payload,
			text,
		);
	}

	async publishGrants(peerId: number, grantSet: unknown) {
		return this.requireService().publishGrantSet({ agentId: peerId }, grantSet);
	}

	async requestGrants(peerId: number, grantSet: unknown) {
		return this.requireService().requestGrantSet({ agentId: peerId }, grantSet);
	}

	async installApp(packageName: string): Promise<void> {
		const dataDir = this.options.dataDir;
		// Dynamic import to validate
		const mod = await import(packageName);
		const app: TapApp = mod.default ?? mod;
		if (!app.id || !app.actions) {
			throw new Error(`Package "${packageName}" does not export a valid TapApp`);
		}

		const entry: AppManifestEntry = {
			package: packageName,
			entryPoint: packageName,
			installedAt: new Date().toISOString(),
			status: "active",
		};
		await addAppToManifest(dataDir, app.id, entry);

		// Register immediately if service is running
		if (this.context) {
			this.context.appRegistry.registerApp(app);
		}
	}

	async removeApp(appId: string, options?: { removeState?: boolean }): Promise<void> {
		const dataDir = this.options.dataDir;
		await removeAppFromManifest(dataDir, appId);

		if (this.context) {
			this.context.appRegistry.unregisterApp(appId);
		}

		if (options?.removeState) {
			const { rm } = await import("node:fs/promises");
			const { join } = await import("node:path");
			await rm(join(dataDir, "apps", appId), { recursive: true, force: true });
		}
	}

	listApps(): RegisteredAppInfo[] {
		if (!this.context) return [];
		return this.context.appRegistry.listApps();
	}

	getStatus() {
		return this.requireService().getStatus();
	}

	listPendingRequests() {
		return this.requireService().listPendingRequests();
	}

	async resolvePending(requestId: string, approve: boolean, reason?: string) {
		return this.requireService().resolvePending(requestId, approve, reason);
	}

	private requireService(): TapMessagingService {
		if (!this.service) throw new Error("Runtime not initialized. Call start() first.");
		return this.service;
	}
}

export async function createTapRuntime(
	options: CreateTapRuntimeOptions,
): Promise<TapRuntime> {
	const runtime = new TapRuntime(options);
	return runtime;
}
```

- [ ] **Step 3: Create public API barrel**

```ts
// packages/sdk/src/index.ts

// Runtime
export { TapRuntime, createTapRuntime, type CreateTapRuntimeOptions } from "./runtime.js";

// Re-export app interface types from core
export {
	defineTapApp,
	type TapApp,
	type TapActionContext,
	type TapActionResult,
	type TapActionHandler,
	type TapAppStorage,
	type TapAppEvent,
	type ReadonlyContact,
	type PaymentRequestParams,
	type TransferExecuteParams,
} from "trusted-agents-core";

// Re-export seam interfaces for custom implementations
export {
	type TransportProvider,
	type ITrustStore,
	type IConversationLogger,
	type IRequestJournal,
	type PermissionGrant,
} from "trusted-agents-core";
```

- [ ] **Step 4: Write runtime test**

Write `packages/sdk/test/runtime.test.ts` testing:
- `createTapRuntime()` returns a `TapRuntime` instance
- `runtime.listApps()` returns empty before init
- `runtime.installApp()` validates the package exports a `TapApp`
- `runtime.removeApp()` removes from manifest

Use temp directories and mock the config loading (the test doesn't need a real XMTP transport).

- [ ] **Step 5: Add to root workspace and install**

Add `"packages/sdk"` to root `package.json` workspaces. Run `bun install`.

- [ ] **Step 6: Run all tests**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/ package.json
git commit -m "feat: add @trustedagents/sdk with createTapRuntime

Public SDK entry point for building on TAP. Provides createTapRuntime(),
app install/remove, sendAction(), event subscription, and re-exports
the app interface types."
```

---

## Task 9: CLI App Commands

Add `tap app install/remove/list` commands to the CLI.

**Files:**
- Create: `packages/cli/src/commands/app.ts`
- Modify: `packages/cli/src/cli.ts` (add `app` subcommand group)
- Modify: `packages/cli/package.json` (add `@trustedagents/sdk` dep if needed)

- [ ] **Step 1: Implement app commands**

```ts
// packages/cli/src/commands/app.ts

import type { Command } from "commander";
import {
	loadAppManifest,
	addAppToManifest,
	removeAppFromManifest,
	type AppManifestEntry,
	type TapApp,
} from "trusted-agents-core";

export function registerAppCommands(program: Command): void {
	const app = program.command("app").description("Manage TAP apps");

	app
		.command("install <name>")
		.description("Install a TAP app from npm")
		.action(async (name: string) => {
			const { loadConfig } = await import("../lib/config.js");
			const config = await loadConfig(program);
			const dataDir = config.dataDir;

			// Resolve package name
			const packageName = name.startsWith("@") || name.startsWith("tap-app-")
				? name
				: `tap-app-${name}`;

			console.log(`Installing ${packageName}...`);

			// Validate by importing
			let tapApp: TapApp;
			try {
				const mod = await import(packageName);
				tapApp = mod.default ?? mod;
				if (!tapApp.id || !tapApp.actions || typeof tapApp.actions !== "object") {
					throw new Error("Package does not export a valid TapApp");
				}
			} catch (err) {
				console.error(
					`Failed to load ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
				);
				console.error("Make sure the package is installed: npm install " + packageName);
				process.exitCode = 1;
				return;
			}

			// Check for conflicts
			const manifest = await loadAppManifest(dataDir);
			for (const [existingId, existingEntry] of Object.entries(manifest.apps)) {
				if (existingEntry.status !== "active") continue;
				if (existingId === tapApp.id) {
					console.error(`App "${tapApp.id}" is already installed`);
					process.exitCode = 1;
					return;
				}
			}

			const entry: AppManifestEntry = {
				package: packageName,
				entryPoint: packageName,
				installedAt: new Date().toISOString(),
				status: "active",
			};
			await addAppToManifest(dataDir, tapApp.id, entry);
			console.log(`Installed ${tapApp.name} (${tapApp.id}) v${tapApp.version}`);
			console.log(`Action types: ${Object.keys(tapApp.actions).join(", ")}`);
		});

	app
		.command("remove <name>")
		.description("Remove a TAP app")
		.action(async (name: string) => {
			const { loadConfig } = await import("../lib/config.js");
			const config = await loadConfig(program);
			await removeAppFromManifest(config.dataDir, name);
			console.log(`Removed app "${name}"`);
		});

	app
		.command("list")
		.description("List installed TAP apps")
		.action(async () => {
			const { loadConfig } = await import("../lib/config.js");
			const config = await loadConfig(program);
			const manifest = await loadAppManifest(config.dataDir);

			const apps = Object.entries(manifest.apps);
			if (apps.length === 0) {
				console.log("No apps installed");
				return;
			}

			for (const [id, entry] of apps) {
				const status = entry.status === "active" ? "" : ` (${entry.status})`;
				console.log(`  ${id}${status} — ${entry.package}`);
			}
		});
}
```

- [ ] **Step 2: Register in CLI**

In `packages/cli/src/cli.ts`, add:

```ts
const { registerAppCommands } = await import("./commands/app.js");
registerAppCommands(program);
```

- [ ] **Step 3: Run CLI to verify commands register**

Run: `bunx tap app --help`
Expected: Shows install, remove, list subcommands

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/app.ts packages/cli/src/cli.ts
git commit -m "feat(cli): add tap app install/remove/list commands

CLI surface for managing TAP apps. Validates packages at install time
and checks for action type conflicts."
```

---

## Task 10: Migrate CLI to Use SDK

Replace the CLI's internal composition (`buildContext`, `buildContextWithTransport`, `createCliTapMessagingService`) with `createTapRuntime` from the SDK.

**Files:**
- Modify: `packages/cli/src/lib/context.ts`
- Modify: `packages/cli/src/lib/tap-service.ts`
- Modify: `packages/cli/package.json`
- Modify: various command files that use `buildContext`/`buildContextWithTransport`

- [ ] **Step 1: Add SDK dependency**

Add `"@trustedagents/sdk": "workspace:*"` to `packages/cli/package.json` dependencies. Run `bun install`.

- [ ] **Step 2: Update context.ts to use createTapRuntime**

Replace `buildContextWithTransport` with a function that creates a `TapRuntime` from the SDK, wiring CLI-specific hooks (TTY approval prompting, event emission). Keep `buildContext` for commands that don't need transport (read-only operations).

The key change: commands that currently do `const service = createCliTapMessagingService(context, ...)` will instead do `const runtime = await createTapRuntime({ dataDir, hooks: cliHooks })`.

- [ ] **Step 3: Update command files**

Update each command file that uses `buildContextWithTransport` + `createCliTapMessagingService` to use `createTapRuntime` instead. The public method names on `TapRuntime` match the old service methods, so most changes are mechanical:
- `service.sendMessage(peer, text)` → `runtime.sendMessage(peerId, text)`
- `service.requestFunds(input)` → `runtime.sendAction(peerId, "transfer/request", payload)` (using `buildTransferPayload` from `@trustedagents/app-transfer`)
- `service.requestMeeting(input)` → `runtime.sendAction(peerId, "scheduling/request", payload)` (using `buildSchedulingPayload` from `@trustedagents/app-scheduling`)

- [ ] **Step 4: Run all CLI tests**

Run: `bun run test`
Expected: All tests pass. The E2E test may need updates to the runtime override mechanism.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/
git commit -m "refactor(cli): migrate to @trustedagents/sdk

CLI now uses createTapRuntime from the SDK instead of directly
composing core internals. CLI-specific hooks (TTY prompting,
event emission) are passed through the runtime options."
```

---

## Task 11: Migrate OpenClaw Plugin to Use SDK

Replace `OpenClawTapRegistry.ensureRuntime()` composition with `createTapRuntime` from the SDK.

**Files:**
- Modify: `packages/openclaw-plugin/src/registry.ts`
- Modify: `packages/openclaw-plugin/package.json`

- [ ] **Step 1: Add SDK dependency**

Add `"@trustedagents/sdk": "workspace:*"` to `packages/openclaw-plugin/package.json` dependencies. Run `bun install`.

- [ ] **Step 2: Update ensureRuntime**

Replace the manual composition in `ensureRuntime()` (lines 549-672) with:

```ts
import { createTapRuntime, type TapRuntime } from "@trustedagents/sdk";

// In ensureRuntime():
const runtime = await createTapRuntime({
	dataDir: definition.dataDir,
	hooks: {
		executeTransfer: (config, request) => executeOnchainTransfer(config, request),
		emitEvent: (payload) => this.handleEmitEvent(name, notificationQueue, payload),
		approveTransfer: async (context) => { /* existing grant-check + defer logic */ },
		approveConnection: async () => null, // always defer
		confirmMeeting: async () => false,   // defer to operator
		log: (level, message) => this.logger[level](message),
	},
});
await runtime.start();
```

The `ManagedTapRuntime` type changes to hold a `TapRuntime` instead of a `TapMessagingService`. Tool dispatch methods in `tool.ts` call `runtime.sendMessage()`, `runtime.sendAction()`, etc. instead of `service.sendMessage()`.

- [ ] **Step 3: Update tool dispatch**

Update `packages/openclaw-plugin/src/tool.ts` to use the `TapRuntime` API instead of calling `TapMessagingService` methods directly.

- [ ] **Step 4: Run OpenClaw plugin tests**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-plugin/
git commit -m "refactor(openclaw-plugin): migrate to @trustedagents/sdk

OpenClaw host adapter now uses createTapRuntime from the SDK instead
of directly composing core internals."
```

---

## Task 12: Update E2E Tests and Clean Up

Update the E2E two-agent flow test to work with the new architecture. Remove dead SDK artifacts.

**Files:**
- Modify: `packages/cli/test/e2e-two-agent-flow.test.ts`
- Modify: `packages/cli/test/helpers/loopback-runtime.ts`
- Delete: `packages/sdk/dist/` (old dead SDK artifacts)

- [ ] **Step 1: Update loopback runtime to work with SDK**

The `setCliRuntimeOverride` mechanism needs to work with the SDK's `createTapRuntime`. Either:
- Keep the override mechanism and have `createTapRuntime` check for it (add an override hook)
- Or update the E2E test to create `TapRuntime` instances directly with injected loopback transports via `overrides.transport`

The cleaner approach is the second: the E2E test creates two `TapRuntime` instances with `overrides: { transport: loopbackTransport }` and calls runtime methods directly.

- [ ] **Step 2: Update E2E test**

Update the test to use `createTapRuntime` with loopback transports. The test flow stays the same (init → connect → grant → message → request-funds → etc.), but uses `runtime.sendMessage()`, `runtime.sendAction()`, `runtime.publishGrants()` instead of CLI commands where appropriate.

For CLI-level testing, keep `runCli()` calls for commands that are CLI-specific (init, config, contacts list, app install/list).

- [ ] **Step 3: Delete old SDK artifacts**

```bash
rm -rf packages/sdk/dist
```

The old dead SDK (`packages/sdk/dist/`) with the stale `OrchestratorConfig` using `privateKey` is replaced by the new `packages/sdk/src/`.

- [ ] **Step 4: Run full test suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/ packages/sdk/
git commit -m "test: update E2E tests for open protocol architecture

E2E tests use createTapRuntime with loopback transports. Removes
dead SDK dist artifacts."
```

---

## Task 13: Update CLAUDE.md and Skills

Update the project documentation to reflect the new architecture.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `skills/trusted-agents/SKILL.md`

- [ ] **Step 1: Update CLAUDE.md**

Add the new packages to the system snapshot, dependency direction, and package responsibilities. Update the "Read Order" to include the app module and SDK. Add the `tap app` commands to the "Adding/changing/removing a CLI command" section.

Key additions:
- `packages/sdk -> core` dependency
- `packages/app-transfer -> core` (types only)
- `packages/app-scheduling -> core` (types only)
- `packages/core/src/app/` in the read order
- `apps.json` in the data dir layout
- New "If you change X, also check Y" entry for app interface changes

- [ ] **Step 2: Update SKILL.md**

Add `tap app install/remove/list` commands. Add section explaining the TAP app architecture for agents using the skill.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md skills/trusted-agents/SKILL.md
git commit -m "docs: update CLAUDE.md and skill for open protocol architecture

Reflects new package structure, app system, SDK entry point,
and tap app CLI commands."
```

---

## Summary

| Task | What it does | Depends on |
|---|---|---|
| 1 | App interface types in core | — |
| 2 | File-backed app storage | 1 |
| 3 | App manifest read/write | — |
| 4 | App registry with lazy loading | 1, 3 |
| 5 | Open dispatch in service.ts | 1, 2, 3, 4 |
| 6 | Extract app-transfer | 5 |
| 7 | Extract app-scheduling | 5 |
| 8 | SDK package | 5 |
| 9 | CLI app commands | 3 |
| 10 | Migrate CLI to SDK | 8 |
| 11 | Migrate OpenClaw to SDK | 8 |
| 12 | E2E tests + cleanup | 10, 11 |
| 13 | Docs update | 12 |
