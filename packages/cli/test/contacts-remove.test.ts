/**
 * Tests for `tap contacts remove` — verifies that the command:
 * - Sends a connection/revoke via the service before removing locally
 * - Removes the local contact regardless of revoke delivery success
 * - Returns NOT_FOUND when the connectionId does not exist
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, createCliRuntimeMock, successMock, errorMock, infoMock } = vi.hoisted(
	() => ({
		loadConfigMock: vi.fn(async () => ({})),
		createCliRuntimeMock: vi.fn(),
		successMock: vi.fn(),
		errorMock: vi.fn(),
		infoMock: vi.fn(),
	}),
);

vi.mock("../src/lib/config-loader.js", () => ({
	loadConfig: loadConfigMock,
}));

vi.mock("../src/lib/cli-runtime.js", () => ({
	createCliRuntime: createCliRuntimeMock,
}));

vi.mock("../src/lib/output.js", () => ({
	success: successMock,
	error: errorMock,
	info: infoMock,
}));

import { contactsRemoveCommand } from "../src/commands/contacts-remove.js";

const ACTIVE_CONTACT = {
	connectionId: "conn-abc-123",
	peerAgentId: 42,
	peerChain: "eip155:8453",
	peerDisplayName: "Bob",
	peerAgentAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	peerOwnerAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	status: "active",
	establishedAt: "2026-04-10T00:00:00.000Z",
	lastContactAt: "2026-04-10T00:00:00.000Z",
	permissions: {},
};

const OPTS = { json: true };

describe("tap contacts remove", () => {
	afterEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
	});

	it("sends connection/revoke and removes the local contact on success", async () => {
		const revokeConnection = vi.fn(async () => {});
		const removeContact = vi.fn(async () => {});

		createCliRuntimeMock.mockResolvedValue({
			trustStore: {
				getContacts: vi.fn(async () => [ACTIVE_CONTACT]),
				removeContact,
			},
			service: {
				revokeConnection,
			},
		});

		await contactsRemoveCommand("conn-abc-123", OPTS);

		expect(revokeConnection).toHaveBeenCalledOnce();
		expect(revokeConnection).toHaveBeenCalledWith(ACTIVE_CONTACT);
		expect(removeContact).toHaveBeenCalledOnce();
		expect(removeContact).toHaveBeenCalledWith("conn-abc-123");
		expect(successMock).toHaveBeenCalledOnce();
		const successArgs = successMock.mock.calls[0]?.[0] as { removed: string; peer: string };
		expect(successArgs.removed).toBe("conn-abc-123");
		expect(successArgs.peer).toBe("Bob");
	});

	it("still removes locally even when revokeConnection throws", async () => {
		const revokeConnection = vi.fn(async () => {
			throw new Error("transport unavailable");
		});
		let removedConnectionId: string | undefined;
		const removeContact = vi.fn(async (id: string) => {
			removedConnectionId = id;
		});

		createCliRuntimeMock.mockResolvedValue({
			trustStore: {
				getContacts: vi.fn(async () => [ACTIVE_CONTACT]),
				removeContact,
			},
			service: {
				revokeConnection,
			},
		});

		await contactsRemoveCommand("conn-abc-123", OPTS);

		// revokeConnection was attempted
		expect(revokeConnection).toHaveBeenCalledOnce();
		// Local contact was still removed
		expect(removedConnectionId).toBe("conn-abc-123");
		// Command still succeeded
		expect(successMock).toHaveBeenCalledOnce();
		// No error output
		expect(process.exitCode).not.toBe(4);
	});

	it("returns NOT_FOUND when the connectionId does not exist", async () => {
		createCliRuntimeMock.mockResolvedValue({
			trustStore: {
				getContacts: vi.fn(async () => []),
			},
			service: {
				revokeConnection: vi.fn(),
			},
		});

		await contactsRemoveCommand("conn-nonexistent", OPTS);

		expect(process.exitCode).toBe(4);
		expect(errorMock).toHaveBeenCalledOnce();
		const errorArgs = errorMock.mock.calls[0] as [string, string, unknown];
		expect(errorArgs[0]).toBe("NOT_FOUND");
		expect(successMock).not.toHaveBeenCalled();
	});
});
