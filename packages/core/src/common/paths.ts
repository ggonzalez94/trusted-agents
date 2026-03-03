import { homedir } from "node:os";
import { normalize, resolve, sep } from "node:path";
import { ValidationError } from "./errors.js";

const SAFE_FILE_COMPONENT_REGEX = /^[A-Za-z0-9._-]{1,200}$/;

export function resolveDataDir(dataDir: string): string {
	if (dataDir === "~") {
		return homedir();
	}
	if (dataDir.startsWith(`~${sep}`)) {
		return resolve(homedir(), dataDir.slice(2));
	}
	return resolve(dataDir);
}

export function assertSafeFileComponent(value: string, fieldName: string): void {
	if (!SAFE_FILE_COMPONENT_REGEX.test(value)) {
		throw new ValidationError(
			`${fieldName} contains unsupported characters. Allowed: letters, numbers, dot, underscore, hyphen`,
		);
	}

	if (value.includes("..") || value.includes("/") || value.includes("\\")) {
		throw new ValidationError(`${fieldName} is not a safe file component`);
	}
}

export function assertPathWithinBase(baseDir: string, fullPath: string, fieldName: string): void {
	const normalizedBase = normalize(resolve(baseDir));
	const normalizedPath = normalize(resolve(fullPath));

	if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(`${normalizedBase}${sep}`)) {
		throw new ValidationError(`${fieldName} resolves outside allowed directory`);
	}
}
