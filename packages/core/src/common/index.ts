export {
	TrustedAgentError,
	AuthenticationError,
	IdentityError,
	ConnectionError,
	PermissionError,
	TransportError,
	ConfigError,
	ValidationError,
	toErrorMessage,
	fsErrorCode,
} from "./errors.js";

export { generateNonce, generateConnectionId } from "./crypto.js";

export { nowISO, isExpired, expiresIn, toISO } from "./time.js";

export { isEthereumAddress, isCAIP2Chain, caip2ToChainId } from "./validation.js";

export { AsyncMutex } from "./mutex.js";

export { resolveDataDir, assertSafeFileComponent, assertPathWithinBase } from "./paths.js";

export { buildChainPublicClient, buildChainWalletClient } from "./viem.js";
