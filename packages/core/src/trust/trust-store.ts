import type { Contact } from "./types.js";

export interface ITrustStore {
	getContacts(): Promise<Contact[]>;
	getContact(connectionId: string): Promise<Contact | null>;
	findByAgentAddress(address: `0x${string}`, chain?: string): Promise<Contact | null>;
	findByAgentId(agentId: number, chain: string): Promise<Contact | null>;
	addContact(contact: Contact): Promise<void>;
	updateContact(connectionId: string, updates: Partial<Contact>): Promise<void>;
	removeContact(connectionId: string): Promise<void>;
	touchContact(connectionId: string): Promise<void>;
}
