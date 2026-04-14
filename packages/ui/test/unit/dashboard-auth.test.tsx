import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../components/Dashboard.js";

/**
 * F2.2 — daemon restart rotates the bearer token. The dashboard must:
 *   1. Detect the 401 on the identity probe
 *   2. Clear the stored token
 *   3. Show a recoverable re-auth screen (NOT "Loading…" forever)
 *   4. Retry successfully after the user relaunches `tap ui`
 *
 * We stub `fetch` and `EventSource` here — the Dashboard mounts the full
 * SWR tree and the SSE effect, so both need to be replaced. We never care
 * about SSE deliveries in these tests; we just need `EventSource` to be
 * constructible without blowing up jsdom.
 */

class FakeEventSource {
	url: string;
	constructor(url: string) {
		this.url = url;
	}
	close() {}
	addEventListener() {}
}

const identityPayload = {
	agentId: 42,
	chain: "eip155:8453",
	address: "0xabc",
	displayName: "Alice",
	dataDir: "/tmp/alice",
};

function okJson(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function unauthorized(): Response {
	return new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad token" } }), {
		status: 401,
		headers: { "content-type": "application/json" },
	});
}

function routeFetch(fetchMock: ReturnType<typeof vi.fn>, handler: (url: string) => Response) {
	fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		return handler(url);
	});
}

describe("Dashboard auth lifecycle (F2.2)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		sessionStorage.clear();
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders the re-auth screen when sessionStorage has no token", async () => {
		render(<Dashboard />);
		await waitFor(() => {
			expect(screen.getByText("Dashboard not authenticated")).toBeTruthy();
		});
		// The `tap ui` command appears in a selectable code block.
		expect(screen.getByText("tap ui")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
		// Critically: no "Loading…" spinner bricks the UI.
		expect(screen.queryByText("Loading…")).toBeNull();
		// And no fetches were attempted — we short-circuit before SWR runs.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shows the 'Session ended' screen when the identity probe returns 401", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) return unauthorized();
			return okJson([]);
		});

		render(<Dashboard />);

		await waitFor(() => {
			expect(screen.getByText("Session ended")).toBeTruthy();
		});
		// Stale token was cleared as part of expiry handling.
		expect(sessionStorage.getItem("tapd-token")).toBeNull();
		// We show the recovery command in a code block the user can copy.
		expect(screen.getByText("tap ui")).toBeTruthy();
		// Still never shows the infinite "Loading…" spinner.
		expect(screen.queryByText("Loading…")).toBeNull();
	});

	it("Reload recovers when a fresh token is present in a new dashboard URL", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		let identityStatus: "unauthorized" | "ok" = "unauthorized";
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) {
				return identityStatus === "ok" ? okJson(identityPayload) : unauthorized();
			}
			if (url.includes("/api/contacts")) return okJson([]);
			if (url.includes("/api/conversations")) return okJson([]);
			if (url.includes("/api/pending")) return okJson([]);
			return okJson(null);
		});

		render(<Dashboard />);

		// 1. First, we land on the re-auth screen.
		await waitFor(() => {
			expect(screen.getByText("Session ended")).toBeTruthy();
		});

		// 2. User launches `tap ui` in a new tab, pastes the fresh hash,
		//    and hits Reload. Simulate the fresh token being pushed via
		//    captureToken() — we mimic that here by stashing it and
		//    triggering the Reload button.
		window.location.hash = "token=fresh-token";
		identityStatus = "ok";

		const reloadButton = screen.getByRole("button", { name: "Reload" });
		reloadButton.click();

		// 3. Dashboard re-probes identity and now renders with Alice's data.
		await waitFor(() => {
			// `Alice` is Alice's displayName; it renders in the Sidebar's
			// IdentityHeader.
			expect(screen.queryByText("Session ended")).toBeNull();
		});
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeTruthy();
		});
		expect(sessionStorage.getItem("tapd-token")).toBe("fresh-token");
	});
});
