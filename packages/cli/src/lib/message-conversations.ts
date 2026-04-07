import { ValidationError } from "trusted-agents-core";
import type { Contact } from "trusted-agents-core";

export { findContactForPeer } from "trusted-agents-core";

export function assertContactActive(contact: Contact, peer: string): void {
	if (contact.status !== "active") {
		throw new ValidationError(`Cannot send to ${peer}: contact status is "${contact.status}"`);
	}
}
