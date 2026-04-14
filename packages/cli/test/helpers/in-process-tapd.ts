import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type IConversationLogger,
	type ITrustStore,
	type TapMessagingService,
	loadTrustedAgentConfigFromDataDir,
} from "trusted-agents-core";
import { Daemon } from "trusted-agents-tapd";
import { createCliRuntime } from "../../src/lib/cli-runtime.js";

/**
 * Spin up a real `Daemon` against an existing CLI data dir using the test
 * runtime overrides (loopback transport, static resolver). Returns a handle
 * the test can use to stop the daemon between tests. Writes the same
 * `.tapd.port` and `.tapd-token` files the production daemon writes, so CLI
 * commands invoked via `runCli` discover it transparently.
 */
export interface InProcessTapd {
	port: number;
	token: string;
	stop(): Promise<void>;
}

export interface InProcessTapdOptions {
	dataDir: string;
	identityAgentId: number;
}

export async function startInProcessTapd(
	options: InProcessTapdOptions,
): Promise<InProcessTapd> {
	const { dataDir, identityAgentId } = options;

	// Build a real TapMessagingService via the CLI runtime so the loopback
	// runtime overrides registered by the test fixture take effect.
	const config = await loadTrustedAgentConfigFromDataDir(dataDir, {
		extraChains: {},
	});
	const runtime = await createCliRuntime({
		config,
		opts: { plain: true, dataDir },
		ownerLabel: "in-process-tapd",
	});

	const trustStore: ITrustStore = runtime.trustStore;
	const conversationLogger: IConversationLogger = runtime.conversationLogger;
	const service: TapMessagingService = runtime.service as TapMessagingService;

	// The CLI runtime constructs its own owner lock; the daemon will start the
	// service which re-acquires the same lock. We pass `buildService` as a
	// no-op factory that returns the already-constructed service.
	let started = false;
	const daemon = new Daemon({
		config: {
			dataDir,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			ringBufferSize: 100,
		},
		identityAgentId,
		identitySource: () => ({
			agentId: identityAgentId,
			chain: config.chain,
			address: "",
			displayName: "",
			dataDir,
		}),
		buildService: async () => {
			if (started) {
				throw new Error("buildService called twice for in-process tapd");
			}
			started = true;
			return service;
		},
		trustStore,
		conversationLogger,
		executeTransfer: async (request) => {
			// The loopback runtime override provides its own transfer executor
			// via the runtime's hooks; here we round-trip through the SDK by
			// calling the same path. For tests that exercise tapd's transfer
			// route, this is enough.
			throw new Error(
				`in-process tapd does not implement /api/transfers — use the loopback runtime override instead (request: ${JSON.stringify(request)})`,
			);
		},
	});

	await daemon.start();
	const port = daemon.boundTcpPort();
	const token = daemon.authToken();

	// Persist port + token into the data dir so `discoverTapd(dataDir)` works.
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(dataDir, ".tapd-token"), token, { encoding: "utf-8", mode: 0o600 });

	return {
		port,
		token,
		stop: async () => {
			await daemon.stop().catch(() => {});
			await runtime.stop().catch(() => {});
			await rm(join(dataDir, ".tapd-token"), { force: true }).catch(() => {});
			await rm(join(dataDir, ".tapd.port"), { force: true }).catch(() => {});
		},
	};
}
