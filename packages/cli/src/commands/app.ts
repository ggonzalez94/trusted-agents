import type { TapApp } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

function resolvePackageName(name: string): string {
	if (name.startsWith("@") || name.startsWith("tap-app-")) {
		return name;
	}
	return `tap-app-${name}`;
}

export async function appInstallCommand(name: string, opts: GlobalOptions): Promise<void> {
	try {
		const { loadAppManifest, addAppToManifest } = await import("trusted-agents-core");

		const packageName = resolvePackageName(name);

		// Validate the package exports a valid TapApp
		let tapApp: TapApp;
		try {
			const mod = await import(packageName);
			const exported = mod.default ?? mod.app ?? mod;
			if (
				!exported ||
				typeof exported !== "object" ||
				typeof (exported as Record<string, unknown>).id !== "string" ||
				typeof (exported as Record<string, unknown>).name !== "string" ||
				typeof (exported as Record<string, unknown>).version !== "string" ||
				typeof (exported as Record<string, unknown>).actions !== "object"
			) {
				error(
					"VALIDATION_ERROR",
					`Package "${packageName}" does not export a valid TapApp. Expected an object with id, name, version, and actions fields.`,
					opts,
				);
				process.exitCode = 1;
				return;
			}
			tapApp = exported as TapApp;
		} catch (_importErr) {
			error(
				"NOT_FOUND",
				`Failed to import "${packageName}". Install the package first:\n  npm install ${packageName}\nThen retry: tap app install ${name}`,
				opts,
			);
			process.exitCode = 1;
			return;
		}

		const config = await loadConfig(opts, { requireAgentId: false });
		const manifest = await loadAppManifest(config.dataDir);

		// Check for conflicts with already-installed apps
		const existingEntry = manifest.apps[tapApp.id];
		if (existingEntry) {
			error(
				"CONFLICT",
				`An app with ID "${tapApp.id}" is already installed (from package "${existingEntry.package}"). Remove it first.`,
				opts,
			);
			process.exitCode = 1;
			return;
		}

		await addAppToManifest(config.dataDir, tapApp.id, {
			package: packageName,
			entryPoint: packageName,
			installedAt: new Date().toISOString(),
			status: "active",
		});

		const actionTypes = Object.keys(tapApp.actions);
		console.log(
			`Installed app "${tapApp.name}" (id: ${tapApp.id}, version: ${tapApp.version}, actions: ${actionTypes.join(", ") || "none"})`,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function appRemoveCommand(name: string, opts: GlobalOptions): Promise<void> {
	try {
		const { loadAppManifest, removeAppFromManifest } = await import("trusted-agents-core");
		const config = await loadConfig(opts, { requireAgentId: false });
		const manifest = await loadAppManifest(config.dataDir);

		// Try by app ID first
		if (manifest.apps[name]) {
			await removeAppFromManifest(config.dataDir, name);
			console.log(`Removed app "${name}"`);
			return;
		}

		// Fall back: search by package name
		const resolvedPkg = resolvePackageName(name);
		const matchingId = Object.entries(manifest.apps).find(
			([_, entry]) => entry.package === resolvedPkg || entry.package === name,
		)?.[0];

		if (matchingId) {
			await removeAppFromManifest(config.dataDir, matchingId);
			console.log(`Removed app "${matchingId}" (package: ${resolvedPkg})`);
			return;
		}

		error(
			"NOT_FOUND",
			`No installed app matches "${name}". Run 'tap app list' to see installed apps.`,
			opts,
		);
		process.exitCode = 1;
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function appListCommand(opts: GlobalOptions): Promise<void> {
	try {
		const { loadAppManifest } = await import("trusted-agents-core");
		const config = await loadConfig(opts, { requireAgentId: false });
		const manifest = await loadAppManifest(config.dataDir);
		const entries = Object.entries(manifest.apps);
		if (entries.length === 0) {
			console.log("No apps installed");
			return;
		}
		for (const [id, entry] of entries) {
			const statusSuffix = entry.status !== "active" ? ` [${entry.status}]` : "";
			console.log(`  ${id}${statusSuffix} — ${entry.package}`);
		}
	} catch (err) {
		handleCommandError(err, opts);
	}
}
