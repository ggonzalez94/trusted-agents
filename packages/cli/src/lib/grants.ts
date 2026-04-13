import { readFile } from "node:fs/promises";
import {
	type PermissionGrantSet,
	ValidationError,
	normalizeGrantInput,
} from "trusted-agents-core";
import { toErrorMessage } from "./errors.js";

export async function readGrantFile(path: string): Promise<PermissionGrantSet> {
	const raw = path === "-" ? await readGrantStdin() : await readFile(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ValidationError(`Invalid grant file JSON at ${path}: ${toErrorMessage(error)}`);
	}

	return normalizeGrantInput(parsed);
}

async function readGrantStdin(): Promise<string> {
	if (process.stdin.isTTY) {
		throw new ValidationError("Grant input '-' requires piped JSON on stdin");
	}

	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks).toString("utf-8");
}
