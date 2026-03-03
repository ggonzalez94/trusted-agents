import type { Contact } from "../../src/trust/types.js";
import { ALICE, BOB } from "../fixtures/test-keys.js";

export function createTestContact(overrides: Partial<Contact> = {}): Contact {
	return {
		connectionId: "test-connection-001",
		peerAgentId: 2,
		peerChain: "eip155:1",
		peerOwnerAddress: BOB.address,
		peerDisplayName: "Bob's Agent",
		peerEndpoint: "https://bob-agent.example.com/a2a",
		peerAgentAddress: BOB.address,
		permissions: {
			"general-chat": true,
			scheduling: true,
			purchases: false,
		},
		establishedAt: "2025-01-01T00:00:00.000Z",
		lastContactAt: "2025-01-01T12:00:00.000Z",
		status: "active",
		...overrides,
	};
}

export function createAliceSignerConfig() {
	return {
		privateKey: ALICE.privateKey,
		chainId: 1,
		address: ALICE.address,
	};
}
