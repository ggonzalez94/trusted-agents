export interface TransportSendOptions {
	timeout?: number;
	retries?: number;
	/** Direct peer address — bypasses trust store lookup. Used for initial connection requests to peers not yet in the trust store. */
	peerAddress?: `0x${string}`;
	/**
	 * When false, `send` returns as soon as the message is published to the
	 * underlying transport (e.g., XMTP) and does NOT wait for the peer to
	 * return an application-level JSON-RPC receipt. The returned receipt will
	 * have `status: "published"`. Used for fire-and-forget messages and
	 * durable one-way notifications (results) whose delivery is guaranteed by
	 * the request journal + retry pipeline rather than a synchronous ack.
	 * Defaults to true for backward compatibility.
	 */
	waitForAck?: boolean;
}
