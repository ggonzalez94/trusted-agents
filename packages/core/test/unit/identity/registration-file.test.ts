import { describe, expect, it } from "vitest";
import { validateRegistrationFile } from "../../../src/identity/registration-file.js";
import {
	REGISTRATION_INVALID_ADDRESS,
	REGISTRATION_MISSING_PROTOCOL,
	REGISTRATION_MISSING_SERVICES,
	REGISTRATION_MISSING_TYPE,
	REGISTRATION_NO_A2A_SERVICE,
	REGISTRATION_WRONG_TYPE,
	VALID_REGISTRATION_FILE,
} from "../../fixtures/registration-files.js";

describe("validateRegistrationFile", () => {
	it("should accept a valid registration file", () => {
		const result = validateRegistrationFile(VALID_REGISTRATION_FILE);

		expect(result.type).toBe("eip-8004-registration-v1");
		expect(result.name).toBe("Alice's Agent");
		expect(result.services).toHaveLength(1);
		expect(result.trustedAgentProtocol.version).toBe("1.0");
	});

	it("should throw for a non-object input", () => {
		expect(() => validateRegistrationFile(null)).toThrow("must be a JSON object");
		expect(() => validateRegistrationFile("string")).toThrow("must be a JSON object");
		expect(() => validateRegistrationFile(42)).toThrow("must be a JSON object");
	});

	it("should throw when type field is missing", () => {
		expect(() => validateRegistrationFile(REGISTRATION_MISSING_TYPE)).toThrow(
			"Invalid registration file type",
		);
	});

	it("should throw when type field has the wrong value", () => {
		expect(() => validateRegistrationFile(REGISTRATION_WRONG_TYPE)).toThrow(
			"Invalid registration file type",
		);
	});

	it("should throw when services array is empty", () => {
		expect(() => validateRegistrationFile(REGISTRATION_MISSING_SERVICES)).toThrow(
			"at least one service",
		);
	});

	it("should throw when no a2a service is present", () => {
		expect(() => validateRegistrationFile(REGISTRATION_NO_A2A_SERVICE)).toThrow("name 'a2a'");
	});

	it("should throw when trustedAgentProtocol is missing", () => {
		expect(() => validateRegistrationFile(REGISTRATION_MISSING_PROTOCOL)).toThrow(
			"trustedAgentProtocol",
		);
	});

	it("should throw when agentAddress is invalid", () => {
		expect(() => validateRegistrationFile(REGISTRATION_INVALID_ADDRESS)).toThrow(
			"valid agentAddress",
		);
	});

	it("should throw when name is empty", () => {
		const file = { ...VALID_REGISTRATION_FILE, name: "" };
		expect(() => validateRegistrationFile(file)).toThrow("non-empty name");
	});

	it("should throw when services contain invalid entries", () => {
		// An empty service name with name "a2a" won't match because the a2a check
		// requires name === "a2a", so an empty name service fails the a2a check first
		const file = {
			...VALID_REGISTRATION_FILE,
			services: [
				{ name: "a2a", endpoint: "https://example.com/a2a" },
				{ name: "", endpoint: "https://example.com/other" },
			],
		};
		expect(() => validateRegistrationFile(file)).toThrow("non-empty name");
	});
});
