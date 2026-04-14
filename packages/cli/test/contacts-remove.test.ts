/**
 * Tests for `tap contacts remove` (F3.1 fail-closed fix).
 *
 * The command MUST route through tapd so `connection/revoke` is delivered
 * before local state is deleted — this preserves the revoke-before-delete
 * trust-graph invariant. When tapd is not running, the command fails closed
 * with exit code 2 and does NOT mutate the local trust store.
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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("tap contacts remove (F3.1 fail-closed)", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-contacts-rm-"));
		loadConfigMock.mockResolvedValue({ dataDir });
		removeContactMock.mockResolvedValue(undefined);
		getContactsMock.mockResolvedValue([]);
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		process.exitCode = undefined;
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	it("routes through tapd's POST /api/contacts/:id/revoke when tapd is running", async () => {
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

	it("fails closed with exit code 2 and does NOT touch the trust store when tapd is not running", async () => {
		// No .tapd.port/.tapd-token files → TapdClient.forDataDir throws TapdNotRunningError.
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await contactsRemoveCommand("conn-abc-123", { json: true });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(removeContactMock).not.toHaveBeenCalled();
		expect(successMock).not.toHaveBeenCalled();
		expect(errorMock).toHaveBeenCalledOnce();
		expect(errorMock.mock.calls[0]?.[0]).toBe("TAPD_NOT_RUNNING");
		expect(errorMock.mock.calls[0]?.[1]).toContain("tap daemon start");
		expect(process.exitCode).toBe(2);
	});

	it("surfaces tapd errors (e.g. NOT_FOUND) when the daemon rejects the request", async () => {
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await writeFile(join(dataDir, ".tapd-token"), "token-xyz", "utf-8");

		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: { code: "NOT_FOUND", message: "unknown connection" } }, 404),
		);
		vi.stubGlobal("fetch", fetchMock);

		await contactsRemoveCommand("conn-missing", { json: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(removeContactMock).not.toHaveBeenCalled();
		expect(successMock).not.toHaveBeenCalled();
	});
});
