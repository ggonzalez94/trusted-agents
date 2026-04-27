import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ICalendarProvider } from "trusted-agents-core";
import { ValidationError } from "trusted-agents-core";
import { readYamlFileSync, writeYamlFileAtomic } from "../atomic-write.js";
import { commandExists } from "../shell.js";
import { GoogleCalendarCliProvider } from "./google-calendar.js";

const execFileAsync = promisify(execFile);

export async function checkGwsInstalled(): Promise<boolean> {
	return await commandExists("gws");
}

export async function checkGwsAuthenticated(): Promise<boolean> {
	try {
		await execFileAsync("gws", ["calendar", "+agenda"], {
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

export async function runGwsAuth(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("gws", ["auth", "login", "-s", "calendar"], {
			stdio: "inherit",
		});
		child.on("close", (code) => {
			resolve(code === 0);
		});
		child.on("error", () => {
			resolve(false);
		});
	});
}

export async function writeCalendarConfig(dataDir: string, provider: string): Promise<void> {
	const configPath = join(dataDir, "config.yaml");
	let yaml: Record<string, unknown> = {};

	if (existsSync(configPath)) {
		yaml = readYamlFileSync<Record<string, unknown> | undefined>(configPath) ?? {};
	}

	if (typeof yaml.calendar !== "object" || yaml.calendar === null) {
		yaml.calendar = {};
	}
	(yaml.calendar as Record<string, unknown>).provider = provider;

	await writeYamlFileAtomic(configPath, yaml);
}

export function readCalendarProvider(dataDir: string): string | undefined {
	const configPath = join(dataDir, "config.yaml");
	if (!existsSync(configPath)) {
		return undefined;
	}
	const yaml = readYamlFileSync<Record<string, unknown> | undefined>(configPath);
	if (!yaml || typeof yaml.calendar !== "object" || yaml.calendar === null) {
		return undefined;
	}
	const provider = (yaml.calendar as Record<string, unknown>).provider;
	return typeof provider === "string" ? provider : undefined;
}

export function createCalendarProvider(provider: string): ICalendarProvider {
	if (provider === "google") {
		return new GoogleCalendarCliProvider();
	}
	throw new ValidationError(`Unknown calendar provider: ${provider}`);
}

export function resolveConfiguredCalendarProvider(dataDir: string): ICalendarProvider | undefined {
	const provider = readCalendarProvider(dataDir);
	return provider ? createCalendarProvider(provider) : undefined;
}
