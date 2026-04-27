import { join } from "node:path";

export const XMTP_DATA_DIR = "xmtp";
export const XMTP_SYNC_STATE_FILE = "sync-state.json";

export function xmtpDataDirPath(dataDir: string): string {
	return join(dataDir, XMTP_DATA_DIR);
}

export function xmtpSyncStatePath(dbPath: string): string {
	return join(dbPath, XMTP_SYNC_STATE_FILE);
}
