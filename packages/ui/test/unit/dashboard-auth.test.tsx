import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../components/Dashboard.js";

// Each test renders into its own isolated SWR cache via SWRConfig's
// `provider` option. Without this, the module-level global cache leaks
// between tests — the first test that loads identity + contacts primes
// the cache, and every subsequent test inherits that cache state,
// causing data to look unchanged even when fetch is re-stubbed.
function renderWithIsolatedSwr(node: ReactNode) {
	return render(<SWRConfig value={{ provider: () => new Map() }}>{node}</SWRConfig>);
}

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

/**
 * FakeEventSource lets residual-3 tests synthesize the SSE error path.
 * `EventStream` now subscribes to `error` events and reacts by probing
 * `/api/identity` with the bearer token — so tests grab the instance
 * via `lastInstance` and fire an error manually to drive the probe.
 */
class FakeEventSource {
	static lastInstance: FakeEventSource | null = null;
	url: string;
	closed = false;
	private listeners = new Map<string, ((event: Event) => void)[]>();
	constructor(url: string) {
		this.url = url;
		FakeEventSource.lastInstance = this;
	}
	close() {
		this.closed = true;
	}
	addEventListener(type: string, handler: (event: Event) => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
	}
	dispatchEvent(type: string): void {
		const list = this.listeners.get(type) ?? [];
		for (const handler of list) {
			handler(new Event(type));
		}
	}
}

const identityPayload = {
	agentId: 42,
	chain: "eip155:8453",
	address: "0xabc",
	displayName: "Alice",
	dataDir: "/tmp/alice",
};

const contactPayload = {
	connectionId: "conn-1",
	peerAgentId: 99,
	peerChain: "eip155:8453",
	peerOwnerAddress: "0xdef",
	peerDisplayName: "Bob",
	peerAgentAddress: "0xbob",
	permissions: {
		grantedByMe: { version: "v1", updatedAt: "2026-04-01T00:00:00.000Z", grants: [] },
		grantedByPeer: { version: "v1", updatedAt: "2026-04-01T00:00:00.000Z", grants: [] },
	},
	establishedAt: "2026-04-01T00:00:00.000Z",
	lastContactAt: "2026-04-01T00:00:00.000Z",
	status: "active" as const,
};

const conversationPayload = {
	conversationId: "conv-1",
	connectionId: "conn-1",
	peerAgentId: 99,
	peerDisplayName: "Bob",
	startedAt: "2026-04-01T00:00:00.000Z",
	lastMessageAt: "2026-04-01T00:05:00.000Z",
	lastReadAt: "2026-04-01T00:00:00.000Z",
	status: "active" as const,
	messages: [],
};

const pendingPayload = {
	requestId: "req-1",
	method: "action/request",
	peerAgentId: 99,
	peerChain: "eip155:8453",
	direction: "incoming",
	kind: "action",
	status: "pending",
	details: {
		type: "transfer",
		peerName: "Bob",
		peerChain: "eip155:8453",
		amount: "1.5",
		currency: "USDC",
		chain: "eip155:8453",
	},
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
		FakeEventSource.lastInstance = null;
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		FakeEventSource.lastInstance = null;
	});

	it("renders the re-auth screen when sessionStorage has no token", async () => {
		renderWithIsolatedSwr(<Dashboard />);
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

		renderWithIsolatedSwr(<Dashboard />);

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

	// ── Residual 3: auth covers SSE, markRead, approve, deny ──
	// F2.2 wired TapdUnauthorizedError into SWR fetchers, but the
	// imperative write paths (markConversationRead, approvePending,
	// denyPending) and the SSE stream still surfaced 401 as either a
	// raw rejection or a silent drop. These tests make sure every
	// auth failure funnels through the same re-auth screen.

	it("SSE error during idle triggers re-auth when the probe returns 401", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		let identityStatus: "ok" | "unauthorized" = "ok";
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) {
				return identityStatus === "ok" ? okJson(identityPayload) : unauthorized();
			}
			return okJson([]);
		});

		renderWithIsolatedSwr(<Dashboard />);

		// Dashboard has loaded and is healthy — no re-auth screen yet.
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeTruthy();
		});

		// tapd restarts: the SSE endpoint drops the stream AND the
		// identity probe now returns 401. The EventStream notices
		// the stream error and probes /api/identity — the 401 funnels
		// through onUnauthorized and transitions the dashboard.
		identityStatus = "unauthorized";
		await waitFor(() => {
			expect(FakeEventSource.lastInstance).not.toBeNull();
		});
		await act(async () => {
			FakeEventSource.lastInstance?.dispatchEvent("error");
		});

		await waitFor(() => {
			expect(screen.getByText("Session ended")).toBeTruthy();
		});
		expect(sessionStorage.getItem("tapd-token")).toBeNull();
	});

	it("SSE error during idle stays intact when the probe returns 200 (transient blip)", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) return okJson(identityPayload);
			return okJson([]);
		});

		renderWithIsolatedSwr(<Dashboard />);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeTruthy();
		});

		// Fire an error but the probe succeeds — stream stays connected
		// and the dashboard does NOT transition to re-auth.
		await act(async () => {
			FakeEventSource.lastInstance?.dispatchEvent("error");
		});
		// Give any microtasks the chance to wrongly re-route.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.queryByText("Session ended")).toBeNull();
		expect(screen.getByText("Alice")).toBeTruthy();
	});

	it("approve pending during a stale token triggers re-auth", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		let approveStatus: "ok" | "unauthorized" = "ok";
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) return okJson(identityPayload);
			if (url.includes("/api/contacts")) return okJson([contactPayload]);
			if (url.includes("/api/conversations")) return okJson([conversationPayload]);
			if (url.includes("/api/pending/") && url.includes("/approve")) {
				return approveStatus === "ok" ? okJson({ resolved: true }) : unauthorized();
			}
			if (url.includes("/api/pending")) return okJson([pendingPayload]);
			return okJson(null);
		});

		renderWithIsolatedSwr(<Dashboard />);

		// Wait for the approve button to show up in the pending card.
		const approveButton = await waitFor(() => {
			return screen.getByRole("button", { name: /approve/i });
		});

		// Token just went stale on tapd — the next approve POST 401s.
		approveStatus = "unauthorized";
		await act(async () => {
			fireEvent.click(approveButton);
		});

		await waitFor(() => {
			expect(screen.getByText("Session ended")).toBeTruthy();
		});
		expect(sessionStorage.getItem("tapd-token")).toBeNull();
	});

	it("deny pending during a stale token triggers re-auth", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		let denyStatus: "ok" | "unauthorized" = "ok";
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) return okJson(identityPayload);
			if (url.includes("/api/contacts")) return okJson([contactPayload]);
			if (url.includes("/api/conversations")) return okJson([conversationPayload]);
			if (url.includes("/api/pending/") && url.includes("/deny")) {
				return denyStatus === "ok" ? okJson({ resolved: true }) : unauthorized();
			}
			if (url.includes("/api/pending")) return okJson([pendingPayload]);
			return okJson(null);
		});

		renderWithIsolatedSwr(<Dashboard />);

		const denyButton = await waitFor(() => {
			// ActionCard labels the deny button "Decline"
			return screen.getByRole("button", { name: /decline/i });
		});

		denyStatus = "unauthorized";
		await act(async () => {
			fireEvent.click(denyButton);
		});

		await waitFor(() => {
			expect(screen.getByText("Session ended")).toBeTruthy();
		});
	});

	it("mark-read during a stale token triggers re-auth", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		// Conversation has unread state so the mark-read effect fires
		// as soon as the thread is auto-selected.
		const unreadConversation = {
			...conversationPayload,
			lastReadAt: "2026-04-01T00:00:00.000Z",
			lastMessageAt: "2026-04-02T00:00:00.000Z",
		};
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) return okJson(identityPayload);
			if (url.includes("/api/contacts")) return okJson([contactPayload]);
			if (url.includes("/mark-read")) return unauthorized();
			if (url.includes("/api/conversations")) return okJson([unreadConversation]);
			if (url.includes("/api/pending")) return okJson([]);
			return okJson(null);
		});

		renderWithIsolatedSwr(<Dashboard />);

		await waitFor(() => {
			expect(screen.getByText("Session ended")).toBeTruthy();
		});
		// The stale token was cleared as part of the transition.
		expect(sessionStorage.getItem("tapd-token")).toBeNull();
	});

	it("non-auth errors on approve do not trigger re-auth", async () => {
		sessionStorage.setItem("tapd-token", "stale-token");
		routeFetch(fetchMock, (url) => {
			if (url.includes("/api/identity")) return okJson(identityPayload);
			if (url.includes("/api/contacts")) return okJson([contactPayload]);
			if (url.includes("/api/conversations")) return okJson([conversationPayload]);
			if (url.includes("/api/pending/") && url.includes("/approve")) {
				return new Response(
					JSON.stringify({ error: { code: "internal", message: "tapd exploded" } }),
					{ status: 500, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/api/pending")) return okJson([pendingPayload]);
			return okJson(null);
		});

		renderWithIsolatedSwr(<Dashboard />);

		const approveButton = await waitFor(() => {
			return screen.getByRole("button", { name: /approve/i });
		});

		// Click approve → 500 comes back. Dashboard logs the error
		// via console.error rather than re-throwing, so the card stays
		// pending and the dashboard remains mounted with Alice's data
		// visible. No re-auth screen because the error is non-401.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await act(async () => {
				fireEvent.click(approveButton);
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			errSpy.mockRestore();
		}

		expect(screen.queryByText("Session ended")).toBeNull();
		// Dashboard is still intact with Alice's identity visible.
		expect(screen.getByText("Alice")).toBeTruthy();
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

		renderWithIsolatedSwr(<Dashboard />);

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
