import { FileTrustStore } from "trusted-agents-core";
import type { Contact, ContactPermissionState } from "trusted-agents-core";

export interface ContactEntry {
	name: string;
	agentId: number;
	chain: string;
	status: string;
	permissions: ContactPermissionState;
	lastContact: string;
}

export interface ContactsResult {
	contacts: ContactEntry[];
}

export async function executeContacts(options: { dataDir: string }): Promise<ContactsResult> {
	const trustStore = new FileTrustStore(options.dataDir);
	const rawContacts = await trustStore.getContacts();

	const contacts = rawContacts.map(formatContact);

	return { contacts };
}

function formatContact(contact: Contact): ContactEntry {
	return {
		name: contact.peerDisplayName,
		agentId: contact.peerAgentId,
		chain: contact.peerChain,
		status: contact.status,
		permissions: contact.permissions,
		lastContact: contact.lastContactAt,
	};
}
