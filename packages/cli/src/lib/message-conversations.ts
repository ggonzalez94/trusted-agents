import { ValidationError } from "trusted-agents-core";
import type { Contact } from "trusted-agents-core";

export {
	appendConversationLog,
	buildConversationLogEntry,
	buildOutgoingActionRequest,
	buildOutgoingActionResult,
	buildOutgoingMessageRequest,
	findContactForPeer,
	findUniqueContactForAgentId,
} from "trusted-agents-core";

export function assertContactActive(contact: Contact, peer: string): void {
	if (contact.status !== "active") {
		throw new ValidationError(`Cannot send to ${peer}: contact status is "${contact.status}"`);
	}
}
