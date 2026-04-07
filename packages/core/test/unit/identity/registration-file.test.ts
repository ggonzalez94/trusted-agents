import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityError } from "../../../src/common/index.js";
import {
	fetchRegistrationFile,
	validateRegistrationFile,
} from "../../../src/identity/registration-file.js";
import {
	REGISTRATION_INVALID_ADDRESS,
	REGISTRATION_MISSING_PROTOCOL,
	REGISTRATION_MISSING_SERVICES,
	REGISTRATION_MISSING_TYPE,
	REGISTRATION_NO_XMTP_SERVICE,
	REGISTRATION_WRONG_TYPE,
	VALID_MIXED_REGISTRATION_FILE,
	VALID_REGISTRATION_FILE,
	VALID_XMTP_REGISTRATION_FILE,
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

	it.each([
		["type field is missing", REGISTRATION_MISSING_TYPE, "Invalid registration file type"],
		["type field has the wrong value", REGISTRATION_WRONG_TYPE, "Invalid registration file type"],
		["services array is empty", REGISTRATION_MISSING_SERVICES, "at least one service"],
		["no XMTP transport service is present", REGISTRATION_NO_XMTP_SERVICE, "xmtp"],
	])("should throw when %s", (_, input, expectedMessage) => {
		expect(() => validateRegistrationFile(input)).toThrow(expectedMessage);
	});

	it("should accept a valid XMTP-only registration file", () => {
		const result = validateRegistrationFile(VALID_XMTP_REGISTRATION_FILE);
		expect(result.services).toHaveLength(1);
		expect(result.services[0].name).toBe("xmtp");
	});

	it("should accept a registration file with both a2a and xmtp services", () => {
		const result = validateRegistrationFile(VALID_MIXED_REGISTRATION_FILE);
		expect(result.services).toHaveLength(2);
	});

	it("should throw when xmtp service has invalid Ethereum address endpoint", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			services: [{ name: "xmtp", endpoint: "not-an-address" }],
		};
		expect(() => validateRegistrationFile(file)).toThrow("valid Ethereum address");
	});

	it("should throw when xmtp endpoint does not match trustedAgentProtocol.agentAddress", () => {
		const file = {
			...VALID_XMTP_REGISTRATION_FILE,
			services: [{ name: "xmtp", endpoint: "0x1234567890123456789012345678901234567890" }],
		};
		expect(() => validateRegistrationFile(file)).toThrow(
			"XMTP service endpoint must match trustedAgentProtocol.agentAddress",
		);
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
		const file = {
			...VALID_REGISTRATION_FILE,
			services: [
				{ name: "xmtp", endpoint: VALID_REGISTRATION_FILE.services[0].endpoint },
				{ name: "", endpoint: "https://example.com/other" },
			],
		};
		expect(() => validateRegistrationFile(file)).toThrow("non-empty name");
	});

	it("should accept execution metadata when it is well-formed", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				execution: {
					mode: "eip7702",
					address: VALID_REGISTRATION_FILE.trustedAgentProtocol.agentAddress,
					paymaster: "circle",
				},
			},
		};

		const result = validateRegistrationFile(file);
		expect(result.trustedAgentProtocol.execution?.mode).toBe("eip7702");
		expect(result.trustedAgentProtocol.execution?.paymaster).toBe("circle");
	});

	it("should reject execution metadata with an invalid address", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				execution: {
					mode: "eip7702",
					address: "not-an-address",
				},
			},
		};

		expect(() => validateRegistrationFile(file)).toThrow("execution.address");
	});
});

describe("fetchRegistrationFile", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it.each(["not-a-uri", "https://[invalid"])(
		"should wrap malformed registration URIs in IdentityError: %s",
		async (uri) => {
			const fetchMock = vi.spyOn(globalThis, "fetch");
			const result = fetchRegistrationFile(uri);

			await expect(result).rejects.toBeInstanceOf(IdentityError);
			await expect(result).rejects.toThrow("Invalid registration URI");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://169.254.10.20/registration.json",
		"https://[::1]/registration.json",
		"https://[fe80::1]/registration.json",
		"https://[fc00::1]/registration.json",
		"https://[fd12:3456::1]/registration.json",
	])("should reject unsafe registration hosts: %s", async (uri) => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const result = fetchRegistrationFile(uri);

		await expect(result).rejects.toBeInstanceOf(IdentityError);
		await expect(result).rejects.toThrow("Registration URI is not allowed");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
