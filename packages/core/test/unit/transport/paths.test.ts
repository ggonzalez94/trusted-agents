import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { XMTP_DATA_DIR, xmtpDataDirPath } from "../../../src/transport/index.js";

describe("XMTP transport paths", () => {
	it("pins the default XMTP data directory path", () => {
		expect(XMTP_DATA_DIR).toBe("xmtp");
		expect(xmtpDataDirPath("/tmp/tap-data")).toBe(join("/tmp/tap-data", "xmtp"));
	});
});
