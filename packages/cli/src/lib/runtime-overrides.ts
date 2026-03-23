import type {
	IAgentResolver,
	ICalendarProvider,
	IConversationLogger,
	IRequestJournal,
	ITrustStore,
	TransferActionRequest,
	TransportProvider,
	TrustedAgentsConfig,
} from "trusted-agents-core";

export interface RuntimeContextParts {
	trustStore: ITrustStore;
	resolver: IAgentResolver;
	conversationLogger: IConversationLogger;
	requestJournal: IRequestJournal;
	calendarProvider?: ICalendarProvider;
}

export interface CliRuntimeOverride {
	createContext?: (config: TrustedAgentsConfig) => RuntimeContextParts;
	createTransport?: (
		config: TrustedAgentsConfig,
		context: RuntimeContextParts,
	) => TransportProvider;
	executeTransferAction?: (
		config: TrustedAgentsConfig,
		request: TransferActionRequest,
	) => Promise<{ txHash: `0x${string}` }>;
}

const runtimeOverrides = new Map<string, CliRuntimeOverride>();

export function setCliRuntimeOverride(dataDir: string, override: CliRuntimeOverride): void {
	runtimeOverrides.set(dataDir, override);
}

export function getCliRuntimeOverride(dataDir: string): CliRuntimeOverride | undefined {
	return runtimeOverrides.get(dataDir);
}

export function clearCliRuntimeOverride(dataDir: string): void {
	runtimeOverrides.delete(dataDir);
}
