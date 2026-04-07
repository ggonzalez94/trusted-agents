import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTapHermesAssets } from "../src/hermes/install.js";
import { getTapHermesPaths } from "../src/hermes/config.js";

const execFileAsync = promisify(execFile);

describe("Hermes Python TAP bridge", () => {
	let tempRoot: string;
	let hermesHome: string;
	let binDir: string;
	let originalPath: string | undefined;
	let originalHermesHome: string | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp("/tmp/tap-hermes-python-test-");
		hermesHome = join(tempRoot, "hermes-home");
		binDir = join(tempRoot, "bin");
		await mkdir(binDir, { recursive: true });
		originalPath = process.env.PATH;
		originalHermesHome = process.env.HERMES_HOME;
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
		process.env.HERMES_HOME = hermesHome;
		await installTapHermesAssets(hermesHome);
	});

	afterEach(async () => {
		process.env.PATH = originalPath;
		if (originalHermesHome === undefined) {
			delete process.env.HERMES_HOME;
		} else {
			process.env.HERMES_HOME = originalHermesHome;
		}
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("respawns the daemon when pre_llm_call cannot reach it", async () => {
		const tapLogPath = join(tempRoot, "tap.log");
		await writeFakeTapResponder(binDir, tapLogPath);

		const statePath = getTapHermesPaths(hermesHome).daemonStatePath;
		await writeFile(
			statePath,
			JSON.stringify({
				pid: 999_999,
				gatewayPid: 123,
				socketPath: getTapHermesPaths(hermesHome).socketPath,
				startedAt: "2026-04-07T00:00:00.000Z",
				identities: ["default"],
			}),
			"utf-8",
		);

		const output = await runHermesPluginExpression(
			hermesHome,
			'print(json.dumps(module.inject_tap_notifications()))',
		);

		const result = JSON.parse(output) as { context?: string };
		expect(result.context).toContain("[TAP Notifications]");
		expect(result.context).toContain("Connection request from Alice");
		expect(await readCommandLog(tapLogPath)).toEqual([
			expect.stringContaining("hermes daemon run --gateway-pid"),
		]);
	});

	it("respawns the daemon when tap_gateway cannot reach it", async () => {
		const tapLogPath = join(tempRoot, "tap.log");
		await writeFakeTapResponder(binDir, tapLogPath);

		const output = await runHermesPluginExpression(
			hermesHome,
			'print(module.handle_tap_gateway({"action": "status"}))',
		);

		const result = JSON.parse(output) as { status?: string; healed?: boolean };
		expect(result.status).toBe("ok");
		expect(result.healed).toBe(true);
		expect(await readCommandLog(tapLogPath)).toEqual([
			expect.stringContaining("hermes daemon run --gateway-pid"),
		]);
	});

	it("does not respawn the daemon when the socket is already healthy", async () => {
		const tapLogPath = join(tempRoot, "tap.log");
		await writeFakeTapLogger(binDir, tapLogPath);
		const paths = getTapHermesPaths(hermesHome);

		const server = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (chunk) => {
				const request = JSON.parse(chunk.trim()) as { method?: string };
				socket.end(`${JSON.stringify({ ok: true, result: { status: request.method } })}\n`);
			});
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(paths.socketPath, resolve);
		});

		try {
			const output = await runHermesPluginExpression(
				hermesHome,
				'print(module.handle_tap_gateway({"action": "status"}))',
			);
			const result = JSON.parse(output) as { status?: string };
			expect(result.status).toBe("status");
			await expect(readCommandLog(tapLogPath)).resolves.toEqual([]);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

async function runHermesPluginExpression(hermesHome: string, expression: string): Promise<string> {
	const script = `
import importlib.util
import json
import os
import sys
from pathlib import Path

plugin_dir = Path(os.environ["HERMES_HOME"]) / "plugins" / "trusted-agents-tap"
init_path = plugin_dir / "__init__.py"
spec = importlib.util.spec_from_file_location(
    "trusted_agents_tap",
    init_path,
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["trusted_agents_tap"] = module
spec.loader.exec_module(module)
${expression}
`.trim();

	const result = await execFileAsync("python3", ["-c", script], {
		cwd: hermesHome,
		env: {
			...process.env,
			HERMES_HOME: hermesHome,
		},
		encoding: "utf8",
	});
	return result.stdout.trim();
}

async function writeFakeTapResponder(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "tap");
	const serverCode = String.raw`
import json
import os
import socket
import sys
from pathlib import Path

socket_path = sys.argv[1]
state_path = sys.argv[2]
gateway_pid = int(sys.argv[3])

Path(socket_path).parent.mkdir(parents=True, exist_ok=True)
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen(1)
Path(state_path).write_text(json.dumps({
    "pid": os.getpid(),
    "gatewayPid": gateway_pid,
    "socketPath": socket_path,
    "startedAt": "2026-04-07T00:00:00.000Z",
    "identities": ["default"],
}), encoding="utf-8")

connection, _ = server.accept()
raw = connection.recv(4096).decode("utf-8").strip()
request = json.loads(raw.splitlines()[0]) if raw else {}
if request.get("method") == "drain_notifications":
    response = {
        "ok": True,
        "result": {
            "notifications": [
                {
                    "type": "escalation",
                    "identity": "default",
                    "timestamp": "2026-04-07T00:00:00.000Z",
                    "method": "connection/request",
                    "from": 7,
                    "fromName": "Alice",
                    "messageId": "msg-1",
                    "detail": {},
                    "oneLiner": "Connection request from Alice",
                }
            ]
        },
    }
else:
    response = {"ok": True, "result": {"status": "ok", "healed": True}}
connection.sendall((json.dumps(response) + "\n").encode("utf-8"))
connection.close()
server.close()
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass
`;

	await writeFile(
		scriptPath,
		`#!/usr/bin/env python3
import os
import subprocess
import sys
import time
from pathlib import Path

log_path = Path(${JSON.stringify(logPath)})
log_path.parent.mkdir(parents=True, exist_ok=True)
with log_path.open("a", encoding="utf-8") as log_file:
    log_file.write(" ".join(sys.argv[1:]) + "\\n")

args = sys.argv[1:]
gateway_pid = args[args.index("--gateway-pid") + 1] if "--gateway-pid" in args else "0"
hermes_home = args[args.index("--hermes-home") + 1] if "--hermes-home" in args else os.environ["HERMES_HOME"]
state_dir = Path(hermes_home) / "plugins" / "trusted-agents-tap" / "state"
socket_path = state_dir / "tap-hermes.sock"
state_path = state_dir / "daemon.json"
state_dir.mkdir(parents=True, exist_ok=True)

process = subprocess.Popen(
    [
        sys.executable,
        "-c",
        ${JSON.stringify(serverCode)},
        str(socket_path),
        str(state_path),
        str(gateway_pid),
    ],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    close_fds=True,
)

for _ in range(50):
    if socket_path.exists():
        break
    time.sleep(0.05)

sys.exit(0)
`,
		"utf-8",
	);
	await chmod(scriptPath, 0o755);
}

async function writeFakeTapLogger(binDir: string, logPath: string): Promise<void> {
	const scriptPath = join(binDir, "tap");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${logPath}"
exit 0
`,
		"utf-8",
	);
	await chmod(scriptPath, 0o755);
}

async function readCommandLog(logPath: string): Promise<string[]> {
	try {
		const raw = await readFile(logPath, "utf-8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}
}
