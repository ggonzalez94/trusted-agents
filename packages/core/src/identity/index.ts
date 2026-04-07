export type {
	RegistrationFileExecution,
	RegistrationFile,
	RegistrationFileService,
	RegistrationFileTrustedAgentProtocol,
	ResolvedAgent,
} from "./types.js";

export { ERC8004_ABI } from "./abi.js";

export type { IIdentityRegistry } from "./registry.js";
export { ERC8004Registry } from "./registry.js";

export { fetchRegistrationFile, validateRegistrationFile } from "./registration-file.js";

export type { IAgentResolver } from "./resolver.js";
export { AgentResolver } from "./resolver.js";
