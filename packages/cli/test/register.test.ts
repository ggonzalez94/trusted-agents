import { describe, expect, it } from "vitest";
import { validateRegistrationFile } from "trusted-agents-core";
import type { RegistrationFile } from "trusted-agents-core";

describe("register — registration file construction", () => {
	const agentAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

	it("should build a valid registration file from CLI inputs", () => {
		const name = "Test Agent";
		const description = "A test agent for the trusted agents protocol";
		const capabilities = "scheduling,chat,search";

		const capList = capabilities.split(",").map((c) => c.trim()).filter(Boolean);

		const file: RegistrationFile = {
			type: "eip-8004-registration-v1",
			name,
			description,
			services: [
				{ name: "xmtp", endpoint: agentAddress },
			],
			trustedAgentProtocol: {
				version: "1.0",
				agentAddress,
				capabilities: capList,
			},
		};

		// Should not throw
		const validated = validateRegistrationFile(file);
		expect(validated.name).toBe(name);
		expect(validated.trustedAgentProtocol.capabilities).toEqual(["scheduling", "chat", "search"]);
		expect(validated.services[0]!.name).toBe("xmtp");
		expect(validated.services[0]!.endpoint).toBe(agentAddress);
	});

	it("should reject registration file with empty name", () => {
		const file = {
			type: "eip-8004-registration-v1",
			name: "",
			description: "desc",
			services: [{ name: "xmtp", endpoint: agentAddress }],
			trustedAgentProtocol: { version: "1.0", agentAddress, capabilities: [] },
		};

		expect(() => validateRegistrationFile(file)).toThrow("non-empty name");
	});

	it("should reject registration file without xmtp service", () => {
		const file = {
			type: "eip-8004-registration-v1",
			name: "Test",
			description: "desc",
			services: [{ name: "a2a", endpoint: "https://example.com" }],
			trustedAgentProtocol: { version: "1.0", agentAddress, capabilities: [] },
		};

		expect(() => validateRegistrationFile(file)).toThrow("xmtp");
	});

	it("should reject if xmtp endpoint doesn't match agentAddress", () => {
		const file = {
			type: "eip-8004-registration-v1",
			name: "Test",
			description: "desc",
			services: [{ name: "xmtp", endpoint: "0x0000000000000000000000000000000000000001" }],
			trustedAgentProtocol: { version: "1.0", agentAddress, capabilities: [] },
		};

		expect(() => validateRegistrationFile(file)).toThrow("must match");
	});
});
