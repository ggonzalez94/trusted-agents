import type { NotificationAdapter } from "./notification.js";

export interface ApprovalRequest {
	type: "connection" | "action" | "message";
	description: string;
	details: Record<string, unknown>;
}

export class ApprovalHandler {
	constructor(private readonly notification: NotificationAdapter) {}

	async requestApproval(request: ApprovalRequest): Promise<boolean> {
		const detailLines = Object.entries(request.details)
			.map(([key, value]) => `  ${key}: ${String(value)}`)
			.join("\n");

		const message = `Approval required for ${request.type}:\n${request.description}\n\nDetails:\n${detailLines}`;

		return this.notification.confirm(message);
	}
}
