import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../common/atomic-json.js";
import { AsyncMutex, nowISO, resolveDataDir } from "../common/index.js";
import { ConnectionError } from "../common/index.js";
import type { ITrustStore } from "./trust-store.js";
import type { Contact, ContactsFile } from "./types.js";

export class FileTrustStore implements ITrustStore {
	private readonly contactsPath: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.dataDir = resolveDataDir(dataDir);
		this.contactsPath = join(this.dataDir, "contacts.json");
	}
	private readonly dataDir: string;

	async getContacts(): Promise<Contact[]> {
		const data = await this.load();
		return data.contacts;
	}

	async getContact(connectionId: string): Promise<Contact | null> {
		const data = await this.load();
		return data.contacts.find((c) => c.connectionId === connectionId) ?? null;
	}

	async findByAgentAddress(address: `0x${string}`, chain?: string): Promise<Contact | null> {
		const data = await this.load();
		const lower = address.toLowerCase();
		const matches = data.contacts.filter(
			(c) =>
				c.peerAgentAddress.toLowerCase() === lower &&
				(chain === undefined || c.peerChain === chain),
		);

		if (matches.length === 0) {
			return null;
		}

		const activeMatches = matches.filter((c) => c.status === "active");
		if (activeMatches.length > 1) {
			throw new ConnectionError(
				`Multiple active contacts match address ${address}${chain ? ` on ${chain}` : ""}`,
			);
		}

		if (activeMatches.length === 1) {
			return activeMatches[0] ?? null;
		}

		return matches[0] ?? null;
	}

	async findByAgentId(agentId: number, chain: string): Promise<Contact | null> {
		const data = await this.load();
		return data.contacts.find((c) => c.peerAgentId === agentId && c.peerChain === chain) ?? null;
	}

	async addContact(contact: Contact): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const data = await this.load();
			const existing = data.contacts.find((c) => c.connectionId === contact.connectionId);
			if (existing) {
				throw new ConnectionError(
					`Contact with connectionId ${contact.connectionId} already exists`,
				);
			}

			// Enforce at-most-one-active-contact per (peerAgentAddress, peerChain).
			// Persistent XMTP identities across sessions can cause duplicate active
			// contacts (e.g. an agent re-registers with a new agentId but the same
			// wallet address). Deactivate stale duplicates before inserting.
			if (contact.status === "active") {
				const lowerAddress = contact.peerAgentAddress.toLowerCase();
				for (const c of data.contacts) {
					if (
						c.connectionId !== contact.connectionId &&
						c.status === "active" &&
						c.peerAgentAddress.toLowerCase() === lowerAddress &&
						c.peerChain === contact.peerChain
					) {
						c.status = "stale";
					}
				}
			}

			data.contacts.push(contact);
			await this.save(data);
		});
	}

	async updateContact(connectionId: string, updates: Partial<Contact>): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			if ("connectionId" in updates && updates.connectionId !== connectionId) {
				throw new ConnectionError("connectionId is immutable");
			}

			const data = await this.load();
			const index = data.contacts.findIndex((c) => c.connectionId === connectionId);
			if (index === -1) {
				throw new ConnectionError(`Contact with connectionId ${connectionId} not found`);
			}
			data.contacts[index] = { ...data.contacts[index]!, ...updates } as Contact;
			await this.save(data);
		});
	}

	async removeContact(connectionId: string): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const data = await this.load();
			const index = data.contacts.findIndex((c) => c.connectionId === connectionId);
			if (index === -1) {
				throw new ConnectionError(`Contact with connectionId ${connectionId} not found`);
			}
			data.contacts.splice(index, 1);
			await this.save(data);
		});
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
		await writeJsonFileAtomic(this.contactsPath, data, {
			directoryMode: 0o700,
			tempPrefix: ".contacts",
		});
	}
}
