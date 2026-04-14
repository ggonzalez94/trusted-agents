import { homedir } from "node:os";
import { join } from "node:path";

export interface TapdConfig {
	dataDir: string;
	socketPath: string;
	tcpHost: string;
	tcpPort: number;
	ringBufferSize: number;
}

export interface TapdConfigOptions {
	dataDir?: string;
	socketPath?: string;
	tcpHost?: string;
	tcpPort?: number;
	ringBufferSize?: number;
}

const DEFAULT_DATA_DIR = join(homedir(), ".trustedagents");
const DEFAULT_TCP_HOST = "127.0.0.1";
const DEFAULT_TCP_PORT = 6810;
const DEFAULT_RING_BUFFER_SIZE = 1000;
const SOCKET_FILE = ".tapd.sock";

export const TAPD_PORT_FILE = ".tapd.port";
export const TAPD_PID_FILE = ".tapd.pid";
export const TAPD_TOKEN_FILE = ".tapd-token";

export function resolveTapdConfig(
	env: Record<string, string | undefined>,
	options: TapdConfigOptions,
): TapdConfig {
	const dataDir = options.dataDir ?? env.TAP_DATA_DIR ?? DEFAULT_DATA_DIR;
	const tcpHost = options.tcpHost ?? env.TAPD_HOST ?? DEFAULT_TCP_HOST;
	const tcpPort = options.tcpPort ?? parsePort(env.TAPD_PORT) ?? DEFAULT_TCP_PORT;
	const socketPath = options.socketPath ?? join(dataDir, SOCKET_FILE);
	const ringBufferSize = options.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;

	return { dataDir, socketPath, tcpHost, tcpPort, ringBufferSize };
}

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== value) {
		throw new Error(`TAPD_PORT must be an integer between 1 and 65535, got: ${value}`);
	}
	return parsed;
}
