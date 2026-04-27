import { join } from "node:path";

export const XMTP_DATA_DIR = "xmtp";

export function xmtpDataDirPath(dataDir: string): string {
	return join(dataDir, XMTP_DATA_DIR);
}
