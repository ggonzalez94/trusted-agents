import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	XMTP_DATA_DIR,
	XMTP_SYNC_STATE_FILE,
	xmtpDataDirPath,
	xmtpSyncStatePath,
} from "../../../src/transport/index.js";

describe("XMTP transport paths", () => {
	it("pins the default XMTP data directory path", () => {
		expect(XMTP_DATA_DIR).toBe("xmtp");
		expect(xmtpDataDirPath("/tmp/tap-data")).toBe(join("/tmp/tap-data", "xmtp"));
	});

	it("pins the XMTP sync-state file path", () => {
		expect(XMTP_SYNC_STATE_FILE).toBe("sync-state.json");
		expect(xmtpSyncStatePath("/tmp/tap-data/xmtp")).toBe(
			join("/tmp/tap-data/xmtp", "sync-state.json"),
		);
	});
});
