/**
 * Tests for `tap contacts remove` after the Phase 3 refactor.
 *
 * The command now routes through tapd's POST /api/contacts/:id/revoke when
 * tapd is running, and falls back to a local file delete (no revoke
 * delivery) when tapd is offline. These tests exercise both branches.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, successMock, errorMock, infoMock, removeContactMock, getContactsMock } =
	vi.hoisted(() => ({
		loadConfigMock: vi.fn(),
		successMock: vi.fn(),
		errorMock: vi.fn(),
		infoMock: vi.fn(),
		removeContactMock: vi.fn(),
		getContactsMock: vi.fn(),
	}));

vi.mock("../src/lib/config-loader.js", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/config-loader.js")>(
		"../src/lib/config-loader.js",
	);
	return { ...actual, loadConfig: loadConfigMock };
});

vi.mock("../src/lib/output.js", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/output.js")>("../src/lib/output.js");
	return { ...actual, success: successMock, error: errorMock, info: infoMock };
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		FileTrustStore: vi.fn(() => ({
			getContacts: getContactsMock,
			removeContact: removeContactMock,
		})),
	};
});

import { contactsRemoveCommand } from "../src/commands/contacts-remove.js";

const ACTIVE_CONTACT = {
	connectionId: "conn-abc-123",
	peerAgentId: 42,
	peerChain: "eip155:8453",
	peerDisplayName: "Bob",
	peerAgentAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	peerOwnerAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	status: "active" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("tap contacts remove (tapd client refactor)", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-contacts-rm-"));
		loadConfigMock.mockResolvedValue({ dataDir });
		getContactsMock.mockResolvedValue([ACTIVE_CONTACT]);
		removeContactMock.mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		process.exitCode = undefined;
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	it("routes through tapd when port + token are present", async () => {
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await writeFile(join(dataDir, ".tapd-token"), "token-xyz", "utf-8");

		const fetchMock = vi.fn(async () =>
			jsonResponse({ revoked: true, connectionId: "conn-abc-123", peer: "Bob" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await contactsRemoveCommand("conn-abc-123", { json: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:4321/api/contacts/conn-abc-123/revoke");

		expect(successMock).toHaveBeenCalledOnce();
		const payload = successMock.mock.calls[0]?.[0] as { removed: string; peer: string };
		expect(payload).toEqual({ removed: "conn-abc-123", peer: "Bob" });

		// Local trust store NOT touched on the tapd path — the daemon already
		// removed it.
		expect(removeContactMock).not.toHaveBeenCalled();
	});

	it("falls back to local removal when tapd is not running", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await contactsRemoveCommand("conn-abc-123", { json: true });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(removeContactMock).toHaveBeenCalledWith("conn-abc-123");
		expect(successMock).toHaveBeenCalledOnce();
		const payload = successMock.mock.calls[0]?.[0] as { removed: string; peer: string };
		expect(payload.removed).toBe("conn-abc-123");
	});

	it("returns NOT_FOUND when the contact does not exist (local fallback)", async () => {
		getContactsMock.mockResolvedValue([]);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await contactsRemoveCommand("conn-nonexistent", { json: true });

		expect(process.exitCode).toBe(4);
		expect(errorMock).toHaveBeenCalled();
		expect(errorMock.mock.calls[0]?.[0]).toBe("NOT_FOUND");
		expect(successMock).not.toHaveBeenCalled();
	});
});
