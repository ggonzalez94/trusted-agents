import { FileTrustStore } from "trusted-agents-core";
import type { Contact } from "trusted-agents-core";

export interface ContactEntry {
	name: string;
	agentId: number;
	chain: string;
	status: string;
	permissions: string[];
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
	const permissions = Object.entries(contact.permissions)
		.filter(([, value]) => value !== false)
		.map(([key]) => key);

	return {
		name: contact.peerDisplayName,
		agentId: contact.peerAgentId,
		chain: contact.peerChain,
		status: contact.status,
		permissions,
		lastContact: contact.lastContactAt,
	};
}
