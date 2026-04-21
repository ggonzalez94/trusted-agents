/**
 * Tests for `tap contacts remove` (F3.1 fail-closed fix), updated for the
 * Unix-socket migration.
 *
 * The command MUST route through tapd so `connection/revoke` is delivered
 * before local state is deleted — this preserves the revoke-before-delete
 * trust-graph invariant. When tapd is not running, the command fails closed
 * with exit code 2 and does NOT mutate the local trust store.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeError, type FakeTapdHandle, startFakeTapd } from "./helpers/fake-tapd-socket.ts";

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

describe("tap contacts remove (F3.1 fail-closed)", () => {
	let fake: FakeTapdHandle | null;
	let coldDir: string;

	beforeEach(async () => {
		fake = null;
		// "Cold" data dir is used for the fail-closed path: no `.tapd-token`
		// file means `TapdClient.forDataDir` throws `TapdNotRunningError`
		// before any HTTP work happens.
		coldDir = await mkdtemp(join(tmpdir(), "tap-contacts-rm-cold-"));
		loadConfigMock.mockResolvedValue({ dataDir: coldDir });
		removeContactMock.mockResolvedValue(undefined);
		getContactsMock.mockResolvedValue([]);
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await fake?.stop();
		await rm(coldDir, { recursive: true, force: true }).catch(() => {});
		process.exitCode = undefined;
	});

	async function withFakeTapd(
		routes: Parameters<typeof startFakeTapd>[0]["routes"],
	): Promise<void> {
		fake = await startFakeTapd({ routes });
		loadConfigMock.mockResolvedValue({ dataDir: fake.dataDir });
	}

	it("routes through tapd's POST /api/contacts/:id/revoke when tapd is running", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/contacts/:id/revoke",
				handler: () => ({ revoked: true, connectionId: "conn-abc-123", peer: "Bob" }),
			},
		]);

		await contactsRemoveCommand("conn-abc-123", { json: true });

		expect(fake?.calls).toHaveLength(1);
		expect(fake?.calls[0]?.path).toBe("/api/contacts/conn-abc-123/revoke");

		expect(successMock).toHaveBeenCalledOnce();
		const payload = successMock.mock.calls[0]?.[0] as { removed: string; peer: string };
		expect(payload).toEqual({ removed: "conn-abc-123", peer: "Bob" });

		// Local trust store NOT touched on the tapd path — the daemon already
		// removed it.
		expect(removeContactMock).not.toHaveBeenCalled();
	});

	it("fails closed with exit code 2 and does NOT touch the trust store when tapd is not running", async () => {
		// No `.tapd-token` file in `coldDir` → `TapdClient.forDataDir` throws
		// `TapdNotRunningError` and the command bails before mutating state.
		await contactsRemoveCommand("conn-abc-123", { json: true });

		expect(fake).toBeNull();
		expect(removeContactMock).not.toHaveBeenCalled();
		expect(successMock).not.toHaveBeenCalled();
		expect(errorMock).toHaveBeenCalledOnce();
		expect(errorMock.mock.calls[0]?.[0]).toBe("TAPD_NOT_RUNNING");
		expect(errorMock.mock.calls[0]?.[1]).toContain("tap daemon start");
		expect(process.exitCode).toBe(2);
	});

	it("surfaces tapd errors (e.g. NOT_FOUND) when the daemon rejects the request", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/contacts/:id/revoke",
				handler: () => new FakeError(404, "NOT_FOUND", "unknown connection"),
			},
		]);

		await contactsRemoveCommand("conn-missing", { json: true });

		expect(fake?.calls).toHaveLength(1);
		expect(removeContactMock).not.toHaveBeenCalled();
		expect(successMock).not.toHaveBeenCalled();
	});
});
