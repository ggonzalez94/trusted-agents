import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../../../src/permissions/engine.js";
import { createTestContact } from "../../helpers/test-agent.js";

describe("PermissionEngine", () => {
	const engine = new PermissionEngine();

	it("should allow an explicitly permitted scope", () => {
		const contact = createTestContact({
			permissions: {
				"general-chat": true,
				scheduling: true,
			},
		});

		const result = engine.check(contact, "general-chat");
		expect(result.allowed).toBe(true);
	});

	it("should deny an explicitly denied scope", () => {
		const contact = createTestContact({
			permissions: {
				"general-chat": true,
				purchases: false,
			},
		});

		const result = engine.check(contact, "purchases");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("denied");
	});

	it("should deny an unknown scope (not present in permissions)", () => {
		const contact = createTestContact({
			permissions: {
				"general-chat": true,
			},
		});

		const result = engine.check(contact, "file-sharing");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("Unknown scope");
	});

	it("should allow a scope with object permissions (constraint-based)", () => {
		const contact = createTestContact({
			permissions: {
				research: { topics: ["any"] },
			},
		});

		const result = engine.check(contact, "research");
		expect(result.allowed).toBe(true);
	});

	it("should return the effective permission for a scope", () => {
		const contact = createTestContact({
			permissions: {
				purchases: { maxAmountUsd: 50 },
			},
		});

		const perm = engine.getEffectivePermission(contact, "purchases");
		expect(perm).toEqual({ maxAmountUsd: 50 });
	});

	it("should return null for an unknown scope in getEffectivePermission", () => {
		const contact = createTestContact({
			permissions: {},
		});

		const perm = engine.getEffectivePermission(contact, "unknown");
		expect(perm).toBeNull();
	});
});
