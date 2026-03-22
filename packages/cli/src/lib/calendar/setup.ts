import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { commandExists } from "../shell.js";

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

export function writeCalendarConfig(dataDir: string, provider: string): void {
	const configPath = join(dataDir, "config.yaml");
	let yaml: Record<string, unknown> = {};

	if (existsSync(configPath)) {
		const content = readFileSync(configPath, "utf-8");
		yaml = (YAML.parse(content) as Record<string, unknown>) ?? {};
	}

	if (typeof yaml.calendar !== "object" || yaml.calendar === null) {
		yaml.calendar = {};
	}
	(yaml.calendar as Record<string, unknown>).provider = provider;

	writeFileSync(configPath, YAML.stringify(yaml), "utf-8");
}

export function readCalendarProvider(dataDir: string): string | undefined {
	const configPath = join(dataDir, "config.yaml");
	if (!existsSync(configPath)) {
		return undefined;
	}
	const content = readFileSync(configPath, "utf-8");
	const yaml = YAML.parse(content) as Record<string, unknown> | undefined;
	if (!yaml || typeof yaml.calendar !== "object" || yaml.calendar === null) {
		return undefined;
	}
	const provider = (yaml.calendar as Record<string, unknown>).provider;
	return typeof provider === "string" ? provider : undefined;
}
