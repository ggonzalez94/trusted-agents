import { TapAppRegistry } from "../app/registry.js";
import { buildChainPublicClient, toErrorMessage } from "../common/index.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import type { IConversationLogger } from "../conversation/logger.js";
import { SqliteConversationLogger } from "../conversation/sqlite-logger.js";
import { migrateFileLogsToSqlite } from "../conversation/sqlite-migration.js";
import { AgentResolver, type IAgentResolver } from "../identity/resolver.js";
import type { SigningProvider } from "../signing/provider.js";
import type { TransportProvider } from "../transport/interface.js";
import { xmtpDataDirPath } from "../transport/paths.js";
import { XmtpTransport } from "../transport/xmtp.js";
import { FileTrustStore } from "../trust/file-trust-store.js";
import type { ITrustStore } from "../trust/trust-store.js";
import { FileRequestJournal, type IRequestJournal } from "./request-journal.js";

export interface TapRuntimeContext {
	config: TrustedAgentsConfig;
	signingProvider: SigningProvider;
	trustStore: ITrustStore;
	resolver: IAgentResolver;
	conversationLogger: IConversationLogger;
	requestJournal: IRequestJournal;
	transport: TransportProvider;
	appRegistry: TapAppRegistry;
}

export interface BuildTapRuntimeContextOptions {
	signingProvider: SigningProvider;
	trustStore?: ITrustStore;
	resolver?: IAgentResolver;
	conversationLogger?: IConversationLogger;
	requestJournal?: IRequestJournal;
	transport?: TransportProvider;
	appRegistry?: TapAppRegistry;
}

export async function buildDefaultTapRuntimeContext(
	config: TrustedAgentsConfig,
	options: BuildTapRuntimeContextOptions,
): Promise<TapRuntimeContext> {
	const trustStore = options.trustStore ?? new FileTrustStore(config.dataDir);
	const resolver =
		options.resolver ??
		new AgentResolver(config.chains, buildChainPublicClient, {
			maxCacheEntries: config.resolveCacheMaxEntries,
		});
	let conversationLogger: IConversationLogger;
	if (options.conversationLogger) {
		conversationLogger = options.conversationLogger;
	} else {
		const sqliteLogger = new SqliteConversationLogger(config.dataDir);
		try {
			const report = await migrateFileLogsToSqlite(config.dataDir, sqliteLogger);
			// Partial failures are non-fatal by design: the migration is
			// fail-closed (legacy files are preserved, the flag is not set)
			// so we surface the per-file errors as a warning and proceed
			// with the partially-populated DB. The next startup retries.
			if (report.errors.length > 0) {
				const summary = report.errors
					.slice(0, 5)
					.map((e) => `${e.file}: ${e.error}`)
					.join("; ");
				process.stderr.write(
					`[trusted-agents] conversation log migration left ${report.errors.length} file(s) unimported; will retry next startup. First errors: ${summary}\n`,
				);
			}
		} catch (error: unknown) {
			// Unexpected hard failure (e.g. directory read error). The database
			// is still usable — log and move on.
			process.stderr.write(
				`[trusted-agents] conversation log migration warning: ${toErrorMessage(error)}\n`,
			);
		}
		conversationLogger = sqliteLogger;
	}
	const requestJournal = options.requestJournal ?? new FileRequestJournal(config.dataDir);
	const transport =
		options.transport ??
		new XmtpTransport(
			{
				signingProvider: options.signingProvider,
				chain: config.chain,
				dbPath: xmtpDataDirPath(config.dataDir),
				dbEncryptionKey: config.xmtpDbEncryptionKey,
				agentResolver: resolver,
				resolveCacheTtlMs: config.resolveCacheTtlMs,
			},
			trustStore,
		);
	const appRegistry = options.appRegistry ?? new TapAppRegistry(config.dataDir);
	await appRegistry.loadManifest();

	return {
		config,
		signingProvider: options.signingProvider,
		trustStore,
		resolver,
		conversationLogger,
		requestJournal,
		transport,
		appRegistry,
	};
}
