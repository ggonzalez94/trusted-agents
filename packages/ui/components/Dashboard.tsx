"use client";

import { Composer } from "@/components/chat/Composer";
import { EmptyState } from "@/components/chat/EmptyState";
import { PendingActionCards } from "@/components/chat/PendingActionCards";
import { Thread } from "@/components/chat/Thread";
import { Sidebar } from "@/components/rail/Sidebar";
import { TapdClient } from "@/lib/api";
import { EventStream } from "@/lib/events";
import { getToken } from "@/lib/token";
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

export function Dashboard() {
	const baseUrl = useMemo(() => resolveTapdBaseUrl(), []);
	const client = useMemo(() => new TapdClient(baseUrl), [baseUrl]);
	const { mutate } = useSWRConfig();

	const refresh = useCallback(
		(key: SwrKey) => {
			void mutate(key);
		},
		[mutate],
	);

	const { data: identity } = useSWR<Identity>(SWR_KEYS.identity, () => client.getIdentity());
	const { data: contacts } = useSWR<Contact[]>(SWR_KEYS.contacts, () => client.listContacts());
	const { data: conversations } = useSWR<ConversationLog[]>(SWR_KEYS.conversations, () =>
		client.listConversations(),
	);
	const { data: pending } = useSWR<PendingItem[]>(SWR_KEYS.pending, () => client.listPending());

	const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

	// Auto-select the first active contact when nothing is selected.
	useEffect(() => {
		if (selectedConnectionId || !contacts) return;
		const firstActive = contacts.find((c) => c.status === "active");
		if (firstActive) setSelectedConnectionId(firstActive.connectionId);
	}, [contacts, selectedConnectionId]);

	// Live SSE updates → refresh the SWR cache. Granular invalidation keeps the
	// network chatter scoped, but we still over-invalidate slightly for v1
	// because each refetch is cheap on a local socket.
	useEffect(() => {
		const token = getToken();
		if (!token) return;
		const stream = new EventStream(baseUrl, token, (event: TapEvent) => {
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
		});
		stream.start();
		return () => stream.stop();
	}, [baseUrl, refresh]);

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
	useEffect(() => {
		const conversation = selectedConversation;
		if (!conversation) return;
		const unread = !conversation.lastReadAt || conversation.lastReadAt < conversation.lastMessageAt;
		if (!unread) return;
		void client.markConversationRead(conversation.conversationId).then(() => {
			refresh(SWR_KEYS.conversations);
		});
	}, [client, refresh, selectedConversation]);

	const pendingForThread = useMemo<PendingItem[]>(() => {
		if (!pending || !selectedContact) return [];
		return pending.filter(
			(item) =>
				item.peerAgentId === selectedContact.peerAgentId && item.method === "action/request",
		);
	}, [pending, selectedContact]);

	const handleApprove = useCallback(
		(id: string) =>
			client.approvePending(id).then(() => {
				refresh(SWR_KEYS.pending);
				refresh(SWR_KEYS.conversations);
			}),
		[client, refresh],
	);

	const handleDeny = useCallback(
		(id: string) =>
			client.denyPending(id).then(() => {
				refresh(SWR_KEYS.pending);
				refresh(SWR_KEYS.conversations);
			}),
		[client, refresh],
	);

	if (!identity) {
		return (
			<div className="h-screen grid place-items-center bg-bg-DEFAULT text-text-dim text-sm">
				<div className="font-mono uppercase tracking-[0.18em] text-[10px]">Loading…</div>
			</div>
		);
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
