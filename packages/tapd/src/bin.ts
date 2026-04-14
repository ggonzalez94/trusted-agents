#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	OwsSigningProvider,
	TapMessagingService,
	buildDefaultTapRuntimeContext,
	executeOnchainTransfer,
	loadTrustedAgentConfigFromDataDir,
} from "trusted-agents-core";
import { resolveTapdConfig } from "./config.js";
import { Daemon, TAPD_VERSION } from "./daemon.js";

async function main(): Promise<void> {
	const tapdConfig = resolveTapdConfig(process.env, {});

	process.stdout.write(
		`tapd ${TAPD_VERSION} starting (dataDir=${tapdConfig.dataDir}, port=${tapdConfig.tcpPort})\n`,
	);

	const trustedAgentsConfig = await loadTrustedAgentConfigFromDataDir(tapdConfig.dataDir);
	const signingProvider = new OwsSigningProvider(
		trustedAgentsConfig.ows.wallet,
		trustedAgentsConfig.chain,
		trustedAgentsConfig.ows.apiKey,
	);

	const context = await buildDefaultTapRuntimeContext(trustedAgentsConfig, {
		signingProvider,
	});

	// Capture the agent's own address once at startup so the identity route can
	// surface it to clients (e.g. `tap message request-funds` defaulting --to).
	let agentAddress = "";
	try {
		agentAddress = await signingProvider.getAddress();
	} catch (err) {
		process.stderr.write(
			`tapd warning: failed to resolve own address from signing provider: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}

	const buildService = async (): Promise<TapMessagingService> => {
		return new TapMessagingService(context, {
			ownerLabel: `tapd:${process.pid}`,
			hooks: {
				log: (level, message) => {
					process.stdout.write(`[tapd:${level}] ${message}\n`);
				},
			},
		});
	};

	// The bundled UI lives next to this binary at `<dist>/ui/`. The tapd
	// `postbuild` script copies `packages/ui/out` into that location, so the
	// daemon ships with the entire dashboard inline.
	const here = dirname(fileURLToPath(import.meta.url));
	const staticAssetsDir = join(here, "ui");

	const daemon = new Daemon({
		config: tapdConfig,
		identityAgentId: trustedAgentsConfig.agentId,
		identitySource: () => ({
			agentId: trustedAgentsConfig.agentId,
			chain: trustedAgentsConfig.chain,
			address: agentAddress,
			displayName: "",
			dataDir: tapdConfig.dataDir,
		}),
		buildService,
		trustStore: context.trustStore,
		conversationLogger: context.conversationLogger,
		executeTransfer: async (request) =>
			await executeOnchainTransfer(trustedAgentsConfig, signingProvider, {
				type: "transfer/request",
				actionId: `tapd-${randomUUID()}`,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
			}),
		staticAssetsDir,
	});

	try {
		await daemon.runUntilSignal();
		process.stdout.write("tapd shut down cleanly\n");
		process.exit(0);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`tapd failed: ${message}\n`);
		process.exit(1);
	}
}

void main();
