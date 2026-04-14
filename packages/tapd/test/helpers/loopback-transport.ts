import type {
	InboundRequestEnvelope,
	InboundResultEnvelope,
	ProtocolMessage,
	TransportAck,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "trusted-agents-core";

interface PendingDelivery {
	to: number;
	from: number;
	message: ProtocolMessage;
}

/**
 * Minimal in-memory TransportProvider for tapd unit/integration tests.
 *
 * Two LoopbackTransport instances connected to the same `LoopbackNetwork`
 * deliver messages to each other synchronously through the network's queue.
 * The transport never touches XMTP, the filesystem, or the network — every
 * test runs against this in-memory loop.
 */
export class LoopbackNetwork {
	private readonly transports = new Map<number, LoopbackTransport>();

	register(agentId: number, transport: LoopbackTransport): void {
		this.transports.set(agentId, transport);
	}

	unregister(agentId: number): void {
		this.transports.delete(agentId);
	}

	async deliver(envelope: PendingDelivery): Promise<TransportAck> {
		const target = this.transports.get(envelope.to);
		if (!target) {
			return { status: "queued" };
		}
		return target.receive(envelope.from, envelope.message);
	}
}

export class LoopbackTransport implements TransportProvider {
	private handlers: TransportHandlers = {};
	private started = false;

	constructor(
		private readonly agentId: number,
		private readonly network: LoopbackNetwork,
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		this.network.register(this.agentId, this);
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.network.unregister(this.agentId);
		this.started = false;
	}

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
		const ack = await this.network.deliver({
			to: peerId,
			from: this.agentId,
			message,
		});
		return {
			received: true,
			requestId: String(message.id ?? ""),
			status: ack.status,
			receivedAt: new Date().toISOString(),
		};
	}

	async isReachable(_peerId: number): Promise<boolean> {
		return true;
	}

	async receive(from: number, message: ProtocolMessage): Promise<TransportAck> {
		const isRequest = "method" in message && message.method !== undefined;
		if (isRequest && this.handlers.onRequest) {
			const envelope: InboundRequestEnvelope = {
				from,
				senderInboxId: `loopback-${from}`,
				message,
			};
			return await this.handlers.onRequest(envelope);
		}
		if (!isRequest && this.handlers.onResult) {
			const envelope: InboundResultEnvelope = {
				from,
				senderInboxId: `loopback-${from}`,
				message,
			};
			return await this.handlers.onResult(envelope);
		}
		return { status: "queued" };
	}
}
