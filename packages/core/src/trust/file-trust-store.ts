import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowISO } from "../common/index.js";
import { ConnectionError } from "../common/index.js";
import type { ITrustStore } from "./trust-store.js";
import type { Contact, ContactsFile } from "./types.js";

export class FileTrustStore implements ITrustStore {
	private readonly contactsPath: string;

	constructor(private readonly dataDir: string = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.contactsPath = join(this.dataDir, "contacts.json");
	}

	async getContacts(): Promise<Contact[]> {
		const data = await this.load();
		return data.contacts;
	}

	async getContact(connectionId: string): Promise<Contact | null> {
		const data = await this.load();
		return data.contacts.find((c) => c.connectionId === connectionId) ?? null;
	}

	async findByAgentAddress(address: `0x${string}`): Promise<Contact | null> {
		const data = await this.load();
		const lower = address.toLowerCase();
		return data.contacts.find((c) => c.peerAgentAddress.toLowerCase() === lower) ?? null;
	}

	async findByAgentId(agentId: number, chain: string): Promise<Contact | null> {
		const data = await this.load();
		return data.contacts.find((c) => c.peerAgentId === agentId && c.peerChain === chain) ?? null;
	}

	async addContact(contact: Contact): Promise<void> {
		const data = await this.load();
		const existing = data.contacts.find((c) => c.connectionId === contact.connectionId);
		if (existing) {
			throw new ConnectionError(`Contact with connectionId ${contact.connectionId} already exists`);
		}
		data.contacts.push(contact);
		await this.save(data);
	}

	async updateContact(connectionId: string, updates: Partial<Contact>): Promise<void> {
		const data = await this.load();
		const index = data.contacts.findIndex((c) => c.connectionId === connectionId);
		if (index === -1) {
			throw new ConnectionError(`Contact with connectionId ${connectionId} not found`);
		}
		data.contacts[index] = { ...data.contacts[index]!, ...updates } as Contact;
		await this.save(data);
	}

	async removeContact(connectionId: string): Promise<void> {
		const data = await this.load();
		const index = data.contacts.findIndex((c) => c.connectionId === connectionId);
		if (index === -1) {
			throw new ConnectionError(`Contact with connectionId ${connectionId} not found`);
		}
		data.contacts.splice(index, 1);
		await this.save(data);
	}

	async touchContact(connectionId: string): Promise<void> {
		await this.updateContact(connectionId, { lastContactAt: nowISO() });
	}

	private async load(): Promise<ContactsFile> {
		try {
			const raw = await readFile(this.contactsPath, "utf-8");
			return JSON.parse(raw) as ContactsFile;
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return { contacts: [] };
			}
			throw err;
		}
	}

	private async save(data: ContactsFile): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
		const tmpPath = `${this.contactsPath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(data, null, "\t"), "utf-8");
		await rename(tmpPath, this.contactsPath);
	}
}
