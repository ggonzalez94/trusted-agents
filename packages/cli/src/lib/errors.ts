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

export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_NETWORK_ERROR = 3;
export const EXIT_IDENTITY_ERROR = 4;
export const EXIT_PERMISSION_ERROR = 5;

export function exitCodeForError(err: unknown): number {
	if (err instanceof TransportError) return EXIT_NETWORK_ERROR;
	if (err instanceof IdentityError) return EXIT_IDENTITY_ERROR;
	if (err instanceof AuthenticationError) return EXIT_IDENTITY_ERROR;
	if (err instanceof PermissionError) return EXIT_PERMISSION_ERROR;
	if (err instanceof ConnectionError) return EXIT_PERMISSION_ERROR;
	if (err instanceof ConfigError) return EXIT_GENERAL_ERROR;
	if (err instanceof ValidationError) return EXIT_GENERAL_ERROR;
	if (err instanceof TrustedAgentError) return EXIT_GENERAL_ERROR;
	return EXIT_GENERAL_ERROR;
}

export function errorCode(err: unknown): string {
	if (err instanceof TrustedAgentError && err.code) return err.code;
	if (err instanceof Error) return err.constructor.name.toUpperCase();
	return "UNKNOWN_ERROR";
}
