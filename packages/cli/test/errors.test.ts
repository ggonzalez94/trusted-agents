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
	EXIT_GENERAL_ERROR,
	EXIT_IDENTITY_ERROR,
	EXIT_NETWORK_ERROR,
	EXIT_PERMISSION_ERROR,
	errorCode,
	exitCodeForError,
} from "../src/lib/errors.js";

describe("exitCodeForError", () => {
	it("should return 3 for TransportError", () => {
		expect(exitCodeForError(new TransportError("fail"))).toBe(EXIT_NETWORK_ERROR);
	});

	it("should return 4 for IdentityError", () => {
		expect(exitCodeForError(new IdentityError("fail"))).toBe(EXIT_IDENTITY_ERROR);
	});

	it("should return 4 for AuthenticationError", () => {
		expect(exitCodeForError(new AuthenticationError("fail"))).toBe(EXIT_IDENTITY_ERROR);
	});

	it("should return 5 for PermissionError", () => {
		expect(exitCodeForError(new PermissionError("fail"))).toBe(EXIT_PERMISSION_ERROR);
	});

	it("should return 5 for ConnectionError", () => {
		expect(exitCodeForError(new ConnectionError("fail"))).toBe(EXIT_PERMISSION_ERROR);
	});

	it("should return 1 for ConfigError", () => {
		expect(exitCodeForError(new ConfigError("fail"))).toBe(EXIT_GENERAL_ERROR);
	});

	it("should return 1 for ValidationError", () => {
		expect(exitCodeForError(new ValidationError("fail"))).toBe(EXIT_GENERAL_ERROR);
	});

	it("should return 1 for generic TrustedAgentError", () => {
		expect(exitCodeForError(new TrustedAgentError("fail"))).toBe(EXIT_GENERAL_ERROR);
	});

	it("should return 1 for unknown errors", () => {
		expect(exitCodeForError(new Error("fail"))).toBe(EXIT_GENERAL_ERROR);
		expect(exitCodeForError("string error")).toBe(EXIT_GENERAL_ERROR);
	});
});

describe("errorCode", () => {
	it("should return error code from TrustedAgentError", () => {
		expect(errorCode(new ConfigError("fail"))).toBe("CONFIG_ERROR");
		expect(errorCode(new TransportError("fail"))).toBe("TRANSPORT_ERROR");
	});

	it("should return class name for generic errors", () => {
		expect(errorCode(new TypeError("fail"))).toBe("TYPEERROR");
	});

	it("should return UNKNOWN_ERROR for non-error values", () => {
		expect(errorCode("string")).toBe("UNKNOWN_ERROR");
		expect(errorCode(null)).toBe("UNKNOWN_ERROR");
	});
});
