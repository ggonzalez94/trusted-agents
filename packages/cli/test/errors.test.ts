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
import { describe, expect, it } from "vitest";
import {
	EXIT_AUTH_ERROR,
	EXIT_GENERAL_ERROR,
	EXIT_NOT_FOUND,
	EXIT_TEMPORARY_ERROR,
	EXIT_USAGE_ERROR,
	errorCode,
	exitCodeForError,
} from "../src/lib/errors.js";

describe("exitCodeForError", () => {
	it.each([
		["TransportError", new TransportError("fail"), EXIT_TEMPORARY_ERROR],
		["IdentityError", new IdentityError("fail"), EXIT_GENERAL_ERROR],
		["AuthenticationError", new AuthenticationError("fail"), EXIT_AUTH_ERROR],
		["PermissionError", new PermissionError("fail"), EXIT_AUTH_ERROR],
		["ConnectionError", new ConnectionError("fail"), EXIT_AUTH_ERROR],
		["ConfigError", new ConfigError("fail"), EXIT_USAGE_ERROR],
		["ValidationError", new ValidationError("fail"), EXIT_USAGE_ERROR],
		["NOT_FOUND error", new TrustedAgentError("missing peer", "NOT_FOUND"), EXIT_NOT_FOUND],
		["generic TrustedAgentError", new TrustedAgentError("fail"), EXIT_GENERAL_ERROR],
		["unknown Error", new Error("fail"), EXIT_GENERAL_ERROR],
		["string error", "string error" as unknown as Error, EXIT_GENERAL_ERROR],
	])("returns correct exit code for %s", (_, error, expected) => {
		expect(exitCodeForError(error)).toBe(expected);
	});
});

describe("errorCode", () => {
	it.each([
		["ConfigError", new ConfigError("fail"), "CONFIG_ERROR"],
		["TransportError", new TransportError("fail"), "TRANSPORT_ERROR"],
		["TypeError", new TypeError("fail"), "TYPEERROR"],
		["string value", "string" as unknown as Error, "UNKNOWN_ERROR"],
		["null value", null as unknown as Error, "UNKNOWN_ERROR"],
	])("returns correct error code for %s", (_, error, expected) => {
		expect(errorCode(error)).toBe(expected);
	});
});
