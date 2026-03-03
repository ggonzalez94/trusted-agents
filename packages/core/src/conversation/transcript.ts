import type { ConversationLog } from "./types.js";

export function generateMarkdownTranscript(log: ConversationLog): string {
	const date = log.startedAt.split("T")[0];
	const topic = log.topic ?? "Conversation";
	const lines: string[] = [];

	lines.push(`## ${log.peerDisplayName} | ${topic} | ${date}`);
	lines.push("");

	for (const msg of log.messages) {
		const time = formatTime(msg.timestamp);
		const arrow = msg.direction === "outgoing" ? "\u2192" : "\u2190";
		let header = `**[${time}] ${arrow} ${log.peerDisplayName}:**`;

		if (msg.humanApprovalGiven === true && msg.humanApprovalAt) {
			const approvalTime = formatTime(msg.humanApprovalAt);
			header += ` \u2705 (approved by owner at ${approvalTime})`;
		}

		lines.push(header);
		lines.push(msg.content);
		lines.push("");
	}

	return lines.join("\n");
}

function formatTime(isoTimestamp: string): string {
	const date = new Date(isoTimestamp);
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	return `${hours}:${minutes}`;
}
