import { join } from "node:path";
import { TAPD_PID_FILE } from "./config.js";

export function pidFilePath(dataDir: string): string {
	return join(dataDir, TAPD_PID_FILE);
}
