import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex, nowISO, resolveDataDir } from "../common/index.js";
import { ConnectionError } from "../common/index.js";
import {
	type ContactPermissionState,
	createEmptyPermissionState,
	createGrantSet,
} from "../permissions/types.js";
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
			const parsed = JSON.parse(raw) as ContactsFile;
			return {
				contacts: parsed.contacts.map((contact) => normalizeContact(contact)),
			};
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
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const tmpPath = `${this.contactsPath}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(data, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, this.contactsPath);
	}
}

function normalizeContact(contact: Contact): Contact {
	return {
		...contact,
		permissions: normalizePermissionState(contact.permissions, contact.lastContactAt),
	};
}

function normalizePermissionState(
	value: Contact["permissions"] | Record<string, boolean | Record<string, unknown>>,
	timestamp: string,
): ContactPermissionState {
	if (isDirectionalPermissionState(value)) {
		return value;
	}

	const legacyEntries = Object.entries(value ?? {}).flatMap(([scope, permissionValue]) => {
		if (permissionValue === false) {
			return [];
		}

		return [
			{
				grantId: `legacy:${scope}`,
				scope,
				...(isConstraintObject(permissionValue) ? { constraints: permissionValue } : {}),
			},
		];
	});

	return {
		grantedByMe: createEmptyPermissionState(timestamp).grantedByMe,
		grantedByPeer: createGrantSet(legacyEntries, timestamp),
	};
}

function isDirectionalPermissionState(value: unknown): value is ContactPermissionState {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as {
		grantedByMe?: { grants?: unknown };
		grantedByPeer?: { grants?: unknown };
	};
	return (
		Array.isArray(candidate.grantedByMe?.grants) && Array.isArray(candidate.grantedByPeer?.grants)
	);
}

function isConstraintObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
