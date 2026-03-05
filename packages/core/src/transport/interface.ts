import type { JsonRpcRequest, JsonRpcResponse } from "../protocol/types.js";
import type { TransportSendOptions } from "./types.js";

export type ProtocolMessage = JsonRpcRequest;
export type ProtocolResponse = JsonRpcResponse;

export interface TransportProvider {
	send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<ProtocolResponse>;
	onMessage(callback: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>): void;
	isReachable(peerId: number): Promise<boolean>;
	start?(): Promise<void>;
	stop?(): Promise<void>;
}
