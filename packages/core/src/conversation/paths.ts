import { join } from "node:path";

export const CONVERSATIONS_DB_FILE = "conversations.db";
export const LEGACY_CONVERSATIONS_DIR = "conversations";
export const LEGACY_CONVERSATIONS_BACKUP_DIR = "conversations.bak";

export function conversationsDbPath(dataDir: string): string {
	return join(dataDir, CONVERSATIONS_DB_FILE);
}

export function legacyConversationsDir(dataDir: string): string {
	return join(dataDir, LEGACY_CONVERSATIONS_DIR);
}

export function legacyConversationsBackupDir(dataDir: string, suffix?: number): string {
	return join(
		dataDir,
		suffix === undefined
			? LEGACY_CONVERSATIONS_BACKUP_DIR
			: `${LEGACY_CONVERSATIONS_BACKUP_DIR}.${suffix}`,
	);
}
