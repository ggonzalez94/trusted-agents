export interface TapEmitEventPayload {
	direction: string;
	from: number;
	fromName?: string;
	method: string;
	id: string | number;
	receipt_status: string;
	[key: string]: unknown;
}

export type TapEventBucket = "auto-handle" | "escalate" | "notify";

export function classifyTapEvent(event: TapEmitEventPayload): TapEventBucket | null {
	if (event.direction !== "incoming") return null;
	if (event.receipt_status === "duplicate") return null;

	switch (event.method) {
		case "message/send":
		case "action/result":
		case "permissions/update":
			return "auto-handle";

		case "connection/request":
			return "escalate";

		case "action/request":
			// receipt_status "received" = permission grant request (handled synchronously)
			// Transfer requests (receipt_status "queued") are NOT classified here because
			// the approveTransfer hook fires BEFORE emitEvent in the core runtime's
			// async task flow. The hook owns the notification lifecycle for transfers.
			// Scheduling requests (receipt_status "queued") are handled by the
			// approveScheduling hook, which owns the notification lifecycle.
			return event.receipt_status === "received" ? "auto-handle" : null;

		case "connection/result":
			return "notify";

		case "scheduling/propose":
		case "scheduling/counter":
			return "escalate";

		case "scheduling/accept":
			return "escalate";

		case "scheduling/reject":
			return "auto-handle";

		case "scheduling/cancel":
			return "escalate";

		default:
			return null;
	}
}
