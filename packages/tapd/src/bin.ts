#!/usr/bin/env node
import {
	OwsSigningProvider,
	TapMessagingService,
	buildDefaultTapRuntimeContext,
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

	const daemon = new Daemon({
		config: tapdConfig,
		identityAgentId: trustedAgentsConfig.agentId,
		identitySource: () => ({
			agentId: trustedAgentsConfig.agentId,
			chain: trustedAgentsConfig.chain,
			address: "",
			displayName: "",
			dataDir: tapdConfig.dataDir,
		}),
		buildService,
		trustStore: context.trustStore,
		conversationLogger: context.conversationLogger,
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
