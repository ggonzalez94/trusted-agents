export interface TapEmitEventPayload {
	direction: string;
	from: number;
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
			// All action/request sub-types start as auto-handle.
			// Transfer requests (receipt_status "queued") are promoted to escalation
			// later by the approveTransfer hook if no grants cover them.
			return "auto-handle";

		case "connection/result":
			return "notify";

		default:
			return null;
	}
}
