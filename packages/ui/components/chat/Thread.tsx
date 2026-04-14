"use client";

import { Avatar } from "@/components/ui/avatar";
import { formatChain, formatInitials, formatRelativeTime } from "@/lib/format";
import type { Contact, ConversationLog } from "@/lib/types";
import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";

interface ThreadProps {
	contact: Contact;
	conversation: ConversationLog | null;
	footer?: React.ReactNode;
}

export function Thread({ contact, conversation, footer }: ThreadProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const messageCount = conversation?.messages.length ?? 0;

	// Scroll to the bottom whenever a new message lands. Reading messageCount
	// inside the effect documents intent and keeps the dep array honest — the
	// effect re-fires only when the primitive count changes, which is exactly
	// when we want to glue the viewport to the latest message.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || messageCount === 0) return;
		el.scrollTop = el.scrollHeight;
	}, [messageCount]);

	return (
		<div className="flex-1 flex flex-col bg-bg-main min-w-0">
			<header className="px-6 py-4 border-b border-bg-border flex items-center gap-3.5">
				<Avatar initials={formatInitials(contact.peerDisplayName)} size="lg" variant="primary" />
				<div className="min-w-0">
					<div className="text-sm font-semibold tracking-tight truncate text-text">
						{contact.peerDisplayName}
					</div>
					<div className="text-[11px] text-text-dim font-mono mt-0.5">
						agent #{contact.peerAgentId}
					</div>
				</div>
				<div className="ml-auto inline-flex items-center gap-2">
					<span className="text-[10px] font-mono uppercase tracking-[0.18em] px-2.5 py-1 rounded-pill border border-bg-divider text-text-muted bg-bg-card">
						{formatChain(contact.peerChain)}
					</span>
					<span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] px-2.5 py-1 rounded-pill border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
						<span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_0_rgba(74,222,128,0.7)]" />
						active
					</span>
				</div>
			</header>

			<div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
				{conversation && conversation.messages.length > 0 ? (
					conversation.messages.map((message, idx) => (
						<MessageBubble
							key={message.messageId ?? `${conversation.conversationId}-${idx}`}
							text={message.content}
							direction={message.direction}
							timestamp={formatRelativeTime(message.timestamp)}
							authorInitials={
								message.direction === "outgoing" ? "ME" : formatInitials(contact.peerDisplayName)
							}
						/>
					))
				) : (
					<div className="text-center text-text-dim text-sm py-12 italic">No messages yet</div>
				)}
				{footer}
			</div>
		</div>
	);
}
