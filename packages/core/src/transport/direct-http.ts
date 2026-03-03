import { TransportError } from "../common/index.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { ProtocolMessage, ProtocolResponse, TransportProvider } from "./interface.js";
import type { TransportSendOptions } from "./types.js";

export interface TransportSigner {
	sign(req: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body?: string;
	}): Promise<Record<string, string>>;
}

export class DirectHttpTransport implements TransportProvider {
	private messageCallback?: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>;

	constructor(
		private readonly trustStore: ITrustStore,
		private readonly signer: TransportSigner,
		private readonly chain: string,
	) {}

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<ProtocolResponse> {
		const contact = await this.trustStore.findByAgentId(peerId, this.chain);
		if (!contact) {
			throw new TransportError(`No contact found for agent ${peerId} on chain ${this.chain}`);
		}

		const url = contact.peerEndpoint;
		const body = JSON.stringify(message);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		const signedHeaders = await this.signer.sign({
			method: "POST",
			url,
			headers,
			body,
		});

		const allHeaders = { ...headers, ...signedHeaders };

		const timeout = options?.timeout ?? 30_000;
		const retries = options?.retries ?? 0;

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeout);

				const response = await fetch(url, {
					method: "POST",
					headers: allHeaders,
					body,
					signal: controller.signal,
				});

				clearTimeout(timer);

				if (!response.ok) {
					throw new TransportError(
						`HTTP ${response.status} from agent ${peerId}: ${response.statusText}`,
					);
				}

				const result = (await response.json()) as ProtocolResponse;

				// Update last contact timestamp (fire and forget)
				this.trustStore.touchContact(contact.connectionId).catch(() => {});

				return result;
			} catch (err: unknown) {
				if (err instanceof TransportError) {
					lastError = err;
				} else if (err instanceof Error) {
					lastError = new TransportError(`Request to agent ${peerId} failed: ${err.message}`);
				} else {
					lastError = new TransportError(`Request to agent ${peerId} failed`);
				}
			}
		}

		throw lastError!;
	}

	onMessage(callback: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>): void {
		this.messageCallback = callback;
	}

	getMessageCallback():
		| ((from: number, message: ProtocolMessage) => Promise<ProtocolResponse>)
		| undefined {
		return this.messageCallback;
	}

	async isReachable(peerId: number): Promise<boolean> {
		const contact = await this.trustStore.findByAgentId(peerId, this.chain);
		if (!contact) {
			return false;
		}

		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5_000);

			const response = await fetch(contact.peerEndpoint, {
				method: "HEAD",
				signal: controller.signal,
			});

			clearTimeout(timer);

			// Server is alive if we get any response (2xx or 4xx)
			return response.status < 500;
		} catch {
			return false;
		}
	}
}
