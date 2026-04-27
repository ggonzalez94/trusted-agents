import { describe, expect, it } from "vitest";
import { TAPD_SOCKET_FILE, resolveTapdConfig, socketFilePath } from "../../src/config.js";

describe("resolveTapdConfig", () => {
	it("uses defaults when no env or options provided", () => {
		const config = resolveTapdConfig({}, {});
		expect(config.dataDir).toMatch(/\.trustedagents$/);
		// 0 = OS-assigned ephemeral port. The bound port is written to
		// `.tapd.port` for the UI launcher to discover. A fixed default would
		// collide whenever a second identity (multi-identity Hermes) starts
		// its own tapd.
		expect(config.tcpPort).toBe(0);
		expect(config.tcpHost).toBe("127.0.0.1");
		expect(config.socketPath.endsWith("/.tapd.sock")).toBe(true);
		expect(config.ringBufferSize).toBe(1000);
	});

	it("resolves dataDir from TAP_DATA_DIR env", () => {
		const config = resolveTapdConfig({ TAP_DATA_DIR: "/tmp/foo" }, {});
		expect(config.dataDir).toBe("/tmp/foo");
	});

	it("resolves tcp port from TAPD_PORT env", () => {
		const config = resolveTapdConfig({ TAPD_PORT: "7777" }, {});
		expect(config.tcpPort).toBe(7777);
	});

	it("rejects invalid TAPD_PORT values", () => {
		expect(() => resolveTapdConfig({ TAPD_PORT: "abc" }, {})).toThrow(/TAPD_PORT/);
	});

	it("explicit options override env", () => {
		const config = resolveTapdConfig(
			{ TAP_DATA_DIR: "/tmp/from-env", TAPD_PORT: "7777" },
			{ dataDir: "/tmp/from-options", tcpPort: 8080 },
		);
		expect(config.dataDir).toBe("/tmp/from-options");
		expect(config.tcpPort).toBe(8080);
	});

	it("derives the socket path under the resolved data dir", () => {
		const config = resolveTapdConfig({}, { dataDir: "/tmp/x" });
		expect(config.socketPath).toBe(socketFilePath("/tmp/x"));
	});

	it("exposes the tapd socket file name and path helper", () => {
		expect(TAPD_SOCKET_FILE).toBe(".tapd.sock");
		expect(socketFilePath("/tmp/tap-data")).toBe("/tmp/tap-data/.tapd.sock");
	});
});
