import type { RegistrationFile } from "../../src/identity/types.js";
import { ALICE } from "./test-keys.js";

export const VALID_REGISTRATION_FILE: RegistrationFile = {
	type: "eip-8004-registration-v1",
	name: "Alice's Agent",
	description: "Test agent for unit tests",
	services: [{ name: "a2a", endpoint: "https://alice-agent.example.com/a2a" }],
	trustedAgentProtocol: {
		version: "1.0",
		agentAddress: ALICE.address,
		capabilities: ["scheduling", "general-chat"],
	},
};

export const REGISTRATION_MISSING_TYPE = {
	name: "Bad Agent",
	description: "Missing type field",
	services: [{ name: "a2a", endpoint: "https://example.com/a2a" }],
	trustedAgentProtocol: {
		version: "1.0",
		agentAddress: ALICE.address,
		capabilities: [],
	},
};

export const REGISTRATION_WRONG_TYPE = {
	type: "wrong-type",
	name: "Bad Agent",
	description: "Wrong type value",
	services: [{ name: "a2a", endpoint: "https://example.com/a2a" }],
	trustedAgentProtocol: {
		version: "1.0",
		agentAddress: ALICE.address,
		capabilities: [],
	},
};

export const REGISTRATION_MISSING_SERVICES = {
	type: "eip-8004-registration-v1",
	name: "Bad Agent",
	description: "Missing services",
	services: [],
	trustedAgentProtocol: {
		version: "1.0",
		agentAddress: ALICE.address,
		capabilities: [],
	},
};

export const REGISTRATION_NO_A2A_SERVICE = {
	type: "eip-8004-registration-v1",
	name: "Bad Agent",
	description: "No a2a service",
	services: [{ name: "web", endpoint: "https://example.com" }],
	trustedAgentProtocol: {
		version: "1.0",
		agentAddress: ALICE.address,
		capabilities: [],
	},
};

export const REGISTRATION_MISSING_PROTOCOL = {
	type: "eip-8004-registration-v1",
	name: "Bad Agent",
	description: "Missing trustedAgentProtocol",
	services: [{ name: "a2a", endpoint: "https://example.com/a2a" }],
};

export const REGISTRATION_INVALID_ADDRESS = {
	type: "eip-8004-registration-v1",
	name: "Bad Agent",
	description: "Invalid agent address",
	services: [{ name: "a2a", endpoint: "https://example.com/a2a" }],
	trustedAgentProtocol: {
		version: "1.0",
		agentAddress: "not-an-address",
		capabilities: [],
	},
};
