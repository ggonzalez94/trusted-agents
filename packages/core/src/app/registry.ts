import { toErrorMessage } from "../common/index.js";
import { type AppManifest, loadAppManifest } from "./manifest.js";
import { type TapActionHandler, type TapApp, hasTapAppShape } from "./types.js";

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
				throw new Error(`Action type "${actionType}" is already registered by app "${existing}"`);
			}
		}
		// Clear stale action mappings if re-registering an existing app
		// (e.g., upgrade with changed action types)
		const existing = this.apps.get(app.id);
		if (existing) {
			for (const actionType of Object.keys(existing.actions)) {
				this.actionMap.delete(actionType);
			}
		}
		this.apps.set(app.id, app);
		for (const actionType of Object.keys(app.actions)) {
			this.actionMap.set(actionType, app.id);
		}
		this.log(
			"info",
			`Registered app "${app.id}" with actions: ${Object.keys(app.actions).join(", ")}`,
		);
	}

	unregisterApp(appId: string): void {
		const app = this.apps.get(appId);
		if (!app) return;
		for (const actionType of Object.keys(app.actions)) {
			this.actionMap.delete(actionType);
		}
		this.apps.delete(appId);
		// Also remove from in-memory manifest to prevent re-registration
		// via resolveHandler's lazy-load path
		delete this.manifest.apps[appId];
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
			const app: TapApp = mod.default ?? mod.app ?? mod;
			if (!hasTapAppShape(app)) {
				this.log("error", `App "${appId}" from "${entry.entryPoint}" has invalid TapApp shape`);
				return undefined;
			}
			this.loadedModules.set(entry.entryPoint, app);
			return app;
		} catch (err) {
			this.log(
				"error",
				`Failed to load app "${appId}" from "${entry.entryPoint}": ${toErrorMessage(err)}`,
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
