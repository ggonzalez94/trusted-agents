"use client";

import { Composer } from "@/components/chat/Composer";
import { EmptyState } from "@/components/chat/EmptyState";
import { PendingActionCards } from "@/components/chat/PendingActionCards";
import { Thread } from "@/components/chat/Thread";
import { Sidebar } from "@/components/rail/Sidebar";
import { TapdClient, TapdUnauthorizedError } from "@/lib/api";
import { EventStream } from "@/lib/events";
import { filterPendingForContact } from "@/lib/pending";
import { captureToken, clearToken, getToken } from "@/lib/token";
import type { Contact, ConversationLog, Identity, PendingItem, TapEvent } from "@/lib/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";

// In static-export mode the UI is served from tapd, so the API origin is
// always wherever the page itself was loaded from.
function resolveTapdBaseUrl(): string {
	if (typeof window === "undefined") return "http://127.0.0.1:6810";
	return window.location.origin;
}

const SWR_KEYS = {
	identity: "tapd:identity",
	contacts: "tapd:contacts",
	conversations: "tapd:conversations",
	pending: "tapd:pending",
} as const;

type SwrKey = (typeof SWR_KEYS)[keyof typeof SWR_KEYS];

/**
 * Auth token lifecycle (F2.2).
 *
 * - `missing`: initial state and the state we fall back to when
 *   `sessionStorage` has no token (user opened the dashboard directly).
 * - `present`: we have a token and the API layer is accepting it.
 * - `expired`: a 401 bubbled out of an SWR fetch, so tapd has restarted
 *   (or rotated the token) and the stored value is stale. We clear it,
 *   tear down SSE, and render the re-auth screen.
 */
type TokenState = "missing" | "present" | "expired";

export function Dashboard() {
	const baseUrl = useMemo(() => resolveTapdBaseUrl(), []);
	const client = useMemo(() => new TapdClient(baseUrl), [baseUrl]);
	const { mutate } = useSWRConfig();

	const [tokenState, setTokenState] = useState<TokenState>(() => {
		if (typeof window === "undefined") return "missing";
		return getToken() ? "present" : "missing";
	});

	const refresh = useCallback(
		(key: SwrKey) => {
			void mutate(key);
		},
		[mutate],
	);

	// Shared entry point for every 401 we observe — SWR fetches, SSE
	// probe, and the imperative write handlers (markRead, approve, deny).
	// Clearing state here is idempotent so re-entering the "expired"
	// state is a no-op (residual 3).
	const handleUnauthorized = useCallback(() => {
		clearToken();
		setTokenState("expired");
	}, []);

	// Any SWR fetch that comes back 401 means the stored token is stale.
	// Route through the shared handler so every 401 source funnels to
	// the same recovery path.
	const handleSwrError = useCallback(
		(error: unknown) => {
			if (error instanceof TapdUnauthorizedError) {
				handleUnauthorized();
			}
		},
		[handleUnauthorized],
	);

	const retryAuth = useCallback(() => {
		captureToken();
		const next = getToken();
		if (next) {
			setTokenState("present");
			// Re-run every fetcher now that we (presumably) have a fresh token.
			void mutate(SWR_KEYS.identity);
			void mutate(SWR_KEYS.contacts);
			void mutate(SWR_KEYS.conversations);
			void mutate(SWR_KEYS.pending);
		} else {
			setTokenState("missing");
		}
	}, [mutate]);

	const hasToken = tokenState === "present";

	const { data: identity, error: identityError } = useSWR<Identity>(
		hasToken ? SWR_KEYS.identity : null,
		() => client.getIdentity(),
		{ onError: handleSwrError },
	);
	const { data: contacts } = useSWR<Contact[]>(
		hasToken ? SWR_KEYS.contacts : null,
		() => client.listContacts(),
		{ onError: handleSwrError },
	);
	const { data: conversations } = useSWR<ConversationLog[]>(
		hasToken ? SWR_KEYS.conversations : null,
		() => client.listConversations(),
		{ onError: handleSwrError },
	);
	const { data: pending } = useSWR<PendingItem[]>(
		hasToken ? SWR_KEYS.pending : null,
		() => client.listPending(),
		{ onError: handleSwrError },
	);

	const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

	// Auto-select the first active contact when nothing is selected.
	useEffect(() => {
		if (selectedConnectionId || !contacts) return;
		const firstActive = contacts.find((c) => c.status === "active");
		if (firstActive) setSelectedConnectionId(firstActive.connectionId);
	}, [contacts, selectedConnectionId]);

	// Live SSE updates → refresh the SWR cache. Granular invalidation keeps the
	// network chatter scoped, but we still over-invalidate slightly for v1
	// because each refetch is cheap on a local socket. `tokenState` is a
	// dependency so this effect tears down SSE on expiry and re-runs after
	// a successful re-auth (F2.2).
	useEffect(() => {
		if (tokenState !== "present") return;
		const token = getToken();
		if (!token) return;
		const stream = new EventStream(
			baseUrl,
			token,
			(event: TapEvent) => {
				switch (event.type) {
					case "message.received":
					case "message.sent":
						refresh(SWR_KEYS.conversations);
						break;
					case "action.requested":
					case "action.completed":
					case "action.failed":
					case "action.pending":
					case "pending.resolved":
						refresh(SWR_KEYS.conversations);
						refresh(SWR_KEYS.pending);
						break;
					case "connection.requested":
					case "connection.established":
					case "connection.failed":
					case "contact.updated":
						refresh(SWR_KEYS.contacts);
						refresh(SWR_KEYS.conversations);
						break;
					default:
						break;
				}
			},
			// Idle SSE errors funnel through the same re-auth path as
			// SWR 401s (residual 3). The EventStream probes /api/identity
			// to distinguish a stale token from a transient network blip.
			{ onUnauthorized: handleUnauthorized },
		);
		stream.start();
		return () => stream.stop();
	}, [baseUrl, refresh, tokenState, handleUnauthorized]);

	const selectedContact = useMemo<Contact | null>(() => {
		if (!contacts || !selectedConnectionId) return null;
		return contacts.find((c) => c.connectionId === selectedConnectionId) ?? null;
	}, [contacts, selectedConnectionId]);

	const selectedConversation = useMemo<ConversationLog | null>(() => {
		if (!conversations || !selectedConnectionId) return null;
		return conversations.find((c) => c.connectionId === selectedConnectionId) ?? null;
	}, [conversations, selectedConnectionId]);

	// Mark conversation as read when it becomes selected or when new messages
	// arrive while it's selected. Cheap idempotent POST against tapd.
	// Wrapped in a 401-aware handler so a stale token funnels through
	// the shared re-auth path instead of silently failing (residual 3).
	useEffect(() => {
		if (tokenState !== "present") return;
		const conversation = selectedConversation;
		if (!conversation) return;
		const unread = !conversation.lastReadAt || conversation.lastReadAt < conversation.lastMessageAt;
		if (!unread) return;
		let cancelled = false;
		void (async () => {
			try {
				await client.markConversationRead(conversation.conversationId);
				if (!cancelled) refresh(SWR_KEYS.conversations);
			} catch (error) {
				if (cancelled) return;
				if (error instanceof TapdUnauthorizedError) {
					handleUnauthorized();
				}
				// Non-auth failures are swallowed intentionally — mark-read
				// is fire-and-forget and a transient tapd blip shouldn't
				// disrupt the selection UX.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, refresh, selectedConversation, tokenState, handleUnauthorized]);

	const pendingForThread = useMemo<PendingItem[]>(() => {
		if (!pending || !selectedContact) return [];
		return filterPendingForContact(pending, selectedContact);
	}, [pending, selectedContact]);

	// Approve/deny land on live tapd endpoints, so a stale token there
	// shows up as a 401 rejection. We short-circuit early when we know
	// the token is already expired (avoids a pointless 401 round-trip)
	// and funnel observed 401s through the shared re-auth handler so
	// the UI transitions cleanly instead of surfacing a raw error
	// (residual 3). Non-auth errors are logged to the console rather
	// than thrown so a transient tapd blip doesn't crash the dashboard
	// via an unhandled rejection inside the PendingActionCards click
	// handler — the pending card simply stays pending, and the next
	// SSE refresh reconciles state.
	const handleApprove = useCallback(
		async (id: string) => {
			if (tokenState !== "present") return;
			try {
				await client.approvePending(id);
				refresh(SWR_KEYS.pending);
				refresh(SWR_KEYS.conversations);
			} catch (error) {
				if (error instanceof TapdUnauthorizedError) {
					handleUnauthorized();
					return;
				}
				console.error("tapd approve failed", error);
			}
		},
		[client, refresh, tokenState, handleUnauthorized],
	);

	const handleDeny = useCallback(
		async (id: string) => {
			if (tokenState !== "present") return;
			try {
				await client.denyPending(id);
				refresh(SWR_KEYS.pending);
				refresh(SWR_KEYS.conversations);
			} catch (error) {
				if (error instanceof TapdUnauthorizedError) {
					handleUnauthorized();
					return;
				}
				console.error("tapd deny failed", error);
			}
		},
		[client, refresh, tokenState, handleUnauthorized],
	);

	// F2.2 render priority:
	//   1. Re-auth screen when there is no usable token (fresh visit or stale
	//      token after a daemon restart). This is the recovery path — do NOT
	//      treat it as a loading state.
	//   2. Loading spinner while the first identity probe is in flight.
	//   3. Non-auth error banner when a request fails for some other reason.
	//   4. Dashboard.
	if (tokenState !== "present") {
		return <ReAuthScreen onReload={retryAuth} reason={tokenState} />;
	}

	if (!identity && !identityError) {
		return (
			<div className="h-screen grid place-items-center bg-bg-DEFAULT text-text-dim text-sm">
				<div className="font-mono uppercase tracking-[0.18em] text-[10px]">Loading…</div>
			</div>
		);
	}

	if (identityError && !(identityError instanceof TapdUnauthorizedError)) {
		return <ErrorBanner error={identityError} />;
	}

	if (!identity) {
		// 401 already transitioned tokenState to "expired" in the effect
		// above; this branch only runs for one render before the re-auth
		// screen takes over. Render a blank frame rather than flashing
		// "Loading…".
		return <div className="h-screen bg-bg-DEFAULT" />;
	}

	return (
		<div className="h-screen flex bg-bg-DEFAULT text-text font-sans antialiased">
			<Sidebar
				identity={identity}
				contacts={contacts ?? []}
				conversations={conversations ?? []}
				selectedConnectionId={selectedConnectionId}
				onSelect={setSelectedConnectionId}
			/>
			{selectedContact ? (
				<div className="flex-1 flex flex-col min-w-0">
					<Thread
						contact={selectedContact}
						conversation={selectedConversation}
						footer={
							pendingForThread.length > 0 ? (
								<PendingActionCards
									items={pendingForThread}
									onApprove={handleApprove}
									onDeny={handleDeny}
								/>
							) : null
						}
					/>
					<Composer />
				</div>
			) : (
				<div className="flex-1">
					<EmptyState />
				</div>
			)}
		</div>
	);
}

interface ReAuthScreenProps {
	onReload: () => void;
	reason: Exclude<TokenState, "present">;
}

function ReAuthScreen({ onReload, reason }: ReAuthScreenProps) {
	const heading = reason === "expired" ? "Session ended" : "Dashboard not authenticated";
	const body =
		reason === "expired"
			? "Your tapd session expired. Open a new dashboard session with:"
			: "Open this dashboard via tap ui so the local daemon can hand you an authenticated session URL:";
	return (
		<div className="h-screen grid place-items-center bg-bg-DEFAULT text-text">
			<div className="text-center max-w-md px-6">
				<div className="text-[10px] uppercase tracking-[0.18em] text-text-faint mb-3 font-mono">
					tapd dashboard
				</div>
				<div className="text-base font-semibold tracking-tight text-text mb-2">{heading}</div>
				<div className="text-xs text-text-muted leading-relaxed mb-4">{body}</div>
				<pre className="bg-bg-elevated px-3 py-2 rounded font-mono text-[12px] text-text inline-block select-all mb-4">
					tap ui
				</pre>
				<div>
					<button
						type="button"
						onClick={onReload}
						className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted hover:text-text border border-bg-divider rounded-pill px-3 py-1.5"
					>
						Reload
					</button>
				</div>
			</div>
		</div>
	);
}

interface ErrorBannerProps {
	error: unknown;
}

function ErrorBanner({ error }: ErrorBannerProps) {
	const message =
		error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
	return (
		<div className="h-screen grid place-items-center bg-bg-DEFAULT text-text">
			<div className="text-center max-w-md px-6">
				<div className="text-[10px] uppercase tracking-[0.18em] text-text-faint mb-3 font-mono">
					tapd dashboard
				</div>
				<div className="text-base font-semibold tracking-tight text-text mb-2">
					tapd request failed
				</div>
				<div className="text-xs text-text-muted leading-relaxed font-mono">{message}</div>
			</div>
		</div>
	);
}
