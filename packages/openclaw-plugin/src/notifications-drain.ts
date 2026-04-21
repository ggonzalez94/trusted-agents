import type { OpenClawTapdClient, TapNotification, TapNotificationType } from "./tapd-client.js";

const LABELS: Record<TapNotificationType, string> = {
	info: "INFO",
	escalation: "ESCALATION",
	"auto-reply": "AUTO-REPLY",
	summary: "SUMMARY",
};

const MAX_NOTIFICATIONS = 20;
const HEADER = "[TAP Notifications]";

export interface PrependContextResult {
	prependContext: string;
}

/**
 * Drains queued tapd notifications and formats them as the `[TAP Notifications]`
 * block the OpenClaw `before_prompt_build` hook prepends to the agent context.
 *
 * Returns null when there is nothing to surface so the caller can short-circuit
 * without producing an empty block. Truncates at MAX_NOTIFICATIONS and adds a
 * SUMMARY footer line for the omitted tail so the agent knows to drain again.
 */
export async function drainAndFormatNotifications(
	client: OpenClawTapdClient,
): Promise<PrependContextResult | null> {
	const result = await client.drainNotifications();
	const notifications: TapNotification[] = result.notifications ?? [];
	if (notifications.length === 0) return null;

	const lines: string[] = [HEADER];
	let rendered = 0;
	for (const notification of notifications.slice(0, MAX_NOTIFICATIONS)) {
		const label = LABELS[notification.type] ?? "INFO";
		const oneLiner = (notification.oneLiner ?? "").trim();
		if (!oneLiner) continue;
		lines.push(`- ${label}: ${oneLiner}`);
		rendered += 1;
	}

	if (rendered === 0) return null;

	const remaining = notifications.length - MAX_NOTIFICATIONS;
	if (remaining > 0) {
		lines.push(`- SUMMARY: ${remaining} more TAP notifications omitted.`);
	}

	return { prependContext: lines.join("\n") };
}
