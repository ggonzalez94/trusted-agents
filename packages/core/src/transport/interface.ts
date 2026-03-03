import type { TransportSendOptions } from "./types.js";

export interface ProtocolMessage {
	jsonrpc: "2.0";
	method: string;
	id: string;
	params?: unknown;
}

export interface ProtocolResponse {
	jsonrpc: "2.0";
	id: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface TransportProvider {
	send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<ProtocolResponse>;
	onMessage(callback: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>): void;
	isReachable(peerId: number): Promise<boolean>;
}
