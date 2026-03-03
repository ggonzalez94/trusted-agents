import { describe, expect, it } from "vitest";
import { formatKeyId, parseKeyId } from "../../../src/auth/keyid.js";
import { ALICE } from "../../fixtures/test-keys.js";

describe("formatKeyId", () => {
	it("should format a keyid string from chainId and address", () => {
		const keyId = formatKeyId(1, ALICE.address);
		expect(keyId).toBe(`erc8128:1:${ALICE.address}`);
	});

	it("should throw for an invalid address", () => {
		expect(() => formatKeyId(1, "0xinvalid" as `0x${string}`)).toThrow("Invalid address");
	});

	it("should throw for an invalid chainId", () => {
		expect(() => formatKeyId(0, ALICE.address)).toThrow("Invalid chainId");
		expect(() => formatKeyId(-1, ALICE.address)).toThrow("Invalid chainId");
		expect(() => formatKeyId(1.5, ALICE.address)).toThrow("Invalid chainId");
	});
});

describe("parseKeyId", () => {
	it("should parse a valid keyid string", () => {
		const parsed = parseKeyId(`erc8128:1:${ALICE.address}`);

		expect(parsed.scheme).toBe("erc8128");
		expect(parsed.chainId).toBe(1);
		expect(parsed.address).toBe(ALICE.address);
	});

	it("should round-trip format and parse", () => {
		const keyId = formatKeyId(42, ALICE.address);
		const parsed = parseKeyId(keyId);

		expect(parsed.chainId).toBe(42);
		expect(parsed.address).toBe(ALICE.address);
	});

	it("should throw for an invalid format", () => {
		expect(() => parseKeyId("invalid")).toThrow("Invalid keyid format");
		expect(() => parseKeyId("erc8128:1")).toThrow("Invalid keyid format");
		expect(() => parseKeyId("erc8128:abc:0x1234")).toThrow("Invalid keyid format");
		expect(() => parseKeyId("")).toThrow("Invalid keyid format");
	});

	it("should throw for a keyid with an invalid address", () => {
		// 39 hex chars instead of 40
		expect(() => parseKeyId("erc8128:1:0x123456789012345678901234567890123456789")).toThrow(
			"Invalid keyid format",
		);
	});
});
