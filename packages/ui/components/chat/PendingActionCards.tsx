"use client";

import { formatChain } from "@/lib/format";
import type { ActionKind, PendingItem, PendingTransferDetails } from "@/lib/types";
import { useCallback, useState } from "react";
import { ActionCard, type ActionRow } from "./ActionCard";

interface PendingActionCardsProps {
	items: PendingItem[];
	onApprove: (id: string) => Promise<unknown>;
	onDeny: (id: string) => Promise<unknown>;
}

export function PendingActionCards({ items, onApprove, onDeny }: PendingActionCardsProps) {
	const [pendingId, setPendingId] = useState<string | null>(null);

	const handle = useCallback(
		async (id: string, fn: (id: string) => Promise<unknown>): Promise<void> => {
			setPendingId(id);
			try {
				await fn(id);
			} finally {
				setPendingId(null);
			}
		},
		[],
	);

	return (
		<div className="space-y-3 pt-2">
			{items.map((item) => {
				const kind = (item.kind as ActionKind) ?? "transfer";
				return (
					<ActionCard
						key={item.requestId}
						kind={kind}
						title={pendingTitle(item)}
						subtitle={pendingSubtitle(item)}
						rows={pendingRows(item)}
						status="pending"
						statusText="awaiting you"
						approving={pendingId === item.requestId}
						onApprove={() => handle(item.requestId, onApprove)}
						onDeny={() => handle(item.requestId, onDeny)}
					/>
				);
			})}
		</div>
	);
}

function pendingTitle(item: PendingItem): string {
	const details = item.details;
	if (details?.type === "transfer") {
		return `Send ${details.amount} ${details.currency}`;
	}
	if (details?.type === "scheduling") {
		return details.title || "Meeting proposal";
	}
	return "Action awaiting decision";
}

function pendingSubtitle(item: PendingItem): string {
	const details = item.details;
	if (details?.type === "transfer") {
		return `${details.peerName} requested a transfer on ${formatChain(details.peerChain)}`;
	}
	if (details?.type === "scheduling") {
		const slotCount = details.slots.length;
		return `${details.peerName} proposed ${slotCount} time slot${slotCount === 1 ? "" : "s"}`;
	}
	return `Request ${item.requestId}`;
}

function pendingRows(item: PendingItem): ActionRow[] {
	const details = item.details;
	if (details?.type === "transfer") {
		return transferRows(details);
	}
	if (details?.type === "scheduling") {
		return [
			{ label: "duration", value: `${details.duration} min`, mono: false },
			{ label: "slots", value: `${details.slots.length} proposed`, mono: false },
			{ label: "tz", value: details.originTimezone },
		];
	}
	return [];
}

function transferRows(details: PendingTransferDetails): ActionRow[] {
	const rows: ActionRow[] = [
		{ label: "amount", value: `${details.amount} ${details.currency}` },
		{ label: "chain", value: formatChain(details.chain) },
	];
	if (details.memo) rows.push({ label: "memo", value: details.memo, mono: false });
	return rows;
}
