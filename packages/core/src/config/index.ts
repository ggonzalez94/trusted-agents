export type { ChainConfig, TrustedAgentsConfig } from "./types.js";
export { BASE_MAINNET, BASE_SEPOLIA, DEFAULT_CHAINS, DEFAULT_CONFIG } from "./defaults.js";
export { validateConfig } from "./schema.js";
export {
	loadTrustedAgentConfigFromDataDir,
	resolveTrustedAgentConfigPath,
	type LoadTrustedAgentConfigOptions,
} from "./load.js";
