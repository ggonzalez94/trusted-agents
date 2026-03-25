import { createEmptyPermissionState } from "../../src/permissions/types.js";
import type { Contact } from "../../src/trust/types.js";
import { BOB } from "../fixtures/test-keys.js";

export function createTestContact(overrides: Partial<Contact> = {}): Contact {
	const timestamp = "2025-01-01T12:00:00.000Z";
	return {
		connectionId: "test-connection-001",
		peerAgentId: 2,
		peerChain: "eip155:1",
		peerOwnerAddress: BOB.address,
		peerDisplayName: "Bob's Agent",
		peerAgentAddress: BOB.address,
		permissions: createEmptyPermissionState(timestamp),
		establishedAt: "2025-01-01T00:00:00.000Z",
		lastContactAt: timestamp,
		status: "active",
		...overrides,
	};
}
