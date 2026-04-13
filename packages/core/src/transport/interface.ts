import type { JsonRpcRequest } from "../protocol/types.js";
import type { TransportSendOptions } from "./types.js";

export type ProtocolMessage = JsonRpcRequest;

export interface TransportReceipt {
	received: true;
	requestId: string;
	status: "received" | "duplicate" | "queued" | "published";
	receivedAt: string;
}

export interface TransportAck {
	status: "received" | "duplicate" | "queued";
}

export interface InboundRequestEnvelope {
	from: number;
	senderInboxId: string;
	message: ProtocolMessage;
}

export interface InboundResultEnvelope {
	from: number;
	senderInboxId: string;
	message: ProtocolMessage;
}

export interface TransportHandlers {
	onRequest?: (envelope: InboundRequestEnvelope) => Promise<TransportAck>;
	onResult?: (envelope: InboundResultEnvelope) => Promise<TransportAck>;
}

export interface TransportReconcileOptions {
	consentStates?: string[];
}

export interface TransportReconcileResult {
	synced: true;
	processed: number;
}

export interface TransportProvider {
	send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt>;
	setHandlers(handlers: TransportHandlers): void;
	isReachable(peerId: number): Promise<boolean>;
	reconcile?(options?: TransportReconcileOptions): Promise<TransportReconcileResult>;
	start?(): Promise<void>;
	stop?(): Promise<void>;
}
