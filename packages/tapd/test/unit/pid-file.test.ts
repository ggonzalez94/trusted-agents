import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pidFilePath } from "../../src/pid-file.js";

describe("pid-file", () => {
	it("derives the tapd pid file path under the data dir", () => {
		expect(pidFilePath("/tmp/tap-data")).toBe(join("/tmp/tap-data", ".tapd.pid"));
	});
});
