import {
	AuthenticationError,
	ConfigError,
	ConnectionError,
	IdentityError,
	PermissionError,
	TransportError,
	TrustedAgentError,
	ValidationError,
} from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { error } from "./output.js";

export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_AUTH_ERROR = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_TEMPORARY_ERROR = 5;

export function exitCodeForError(err: unknown): number {
	if (err instanceof TransportError) return EXIT_TEMPORARY_ERROR;
	if (err instanceof AuthenticationError) return EXIT_AUTH_ERROR;
	if (err instanceof PermissionError) return EXIT_AUTH_ERROR;
	if (err instanceof ConnectionError) return EXIT_AUTH_ERROR;
	if (err instanceof ValidationError) return EXIT_USAGE_ERROR;
	if (err instanceof ConfigError) return EXIT_USAGE_ERROR;
	if (err instanceof IdentityError)
		return errorCode(err).includes("NOT_FOUND") ? EXIT_NOT_FOUND : EXIT_GENERAL_ERROR;
	if (errorCode(err).includes("NOT_FOUND")) return EXIT_NOT_FOUND;
	if (err instanceof TrustedAgentError) return EXIT_GENERAL_ERROR;
	return EXIT_GENERAL_ERROR;
}

export function errorCode(err: unknown): string {
	if (err instanceof TrustedAgentError && err.code) return err.code;
	if (err instanceof Error) return err.constructor.name.toUpperCase();
	return "UNKNOWN_ERROR";
}

export function toErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

export function handleCommandError(err: unknown, opts: GlobalOptions): void {
	error(errorCode(err), toErrorMessage(err), opts);
	process.exitCode = exitCodeForError(err);
}
