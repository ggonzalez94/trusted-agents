export interface TransportSendOptions {
	timeout?: number;
	retries?: number;
	/** Direct peer address — bypasses trust store lookup. Used for initial connection requests to peers not yet in the trust store. */
	peerAddress?: `0x${string}`;
}
