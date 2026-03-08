export {
	TrustedAgentError,
	AuthenticationError,
	IdentityError,
	ConnectionError,
	PermissionError,
	TransportError,
	ConfigError,
	ValidationError,
} from "./errors.js";

export { generateNonce, generateConnectionId, bytesToBase64, base64ToBytes } from "./crypto.js";

export { nowISO, nowUnix, isExpired, expiresIn, toISO } from "./time.js";

export {
	isEthereumAddress,
	isValidUrl,
	isValidUUID,
	isCAIP2Chain,
	caip2ToChainId,
	assertEthereumAddress,
} from "./validation.js";

export { AsyncMutex } from "./mutex.js";

export { resolveDataDir, assertSafeFileComponent, assertPathWithinBase } from "./paths.js";

export {
	buildChainPublicClient,
	buildChainTransport,
	buildChainWalletClient,
	getViemChain,
} from "./viem.js";
