import { randomUUID } from "node:crypto";
import type { TapEvent, TapMessagingService, TapPeerRef } from "trusted-agents-core";
import type { EventBus } from "./event-bus.js";

export interface TapdRuntimeOptions {
	service: TapMessagingService;
	identityAgentId: number;
	bus: EventBus;
}

export class TapdRuntime {
	private readonly service: TapMessagingService;
	private readonly identityAgentId: number;
	private readonly bus: EventBus;
	private started = false;

	constructor(options: TapdRuntimeOptions) {
		this.service = options.service;
		this.identityAgentId = options.identityAgentId;
		this.bus = options.bus;
	}

	get tapMessagingService(): TapMessagingService {
		return this.service;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.installEventBridge();
		await this.service.start();
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		await this.service.stop();
		this.started = false;
	}

	private installEventBridge(): void {
		// `TapMessagingService` exposes hooks via its constructor-time options.
		// Here we attach an emitEvent hook that translates raw payloads into
		// typed TapEvents and publishes them to the bus. We mutate the service's
		// hooks object directly because that's how the runtime layer is wired
		// today — see packages/core/src/runtime/service.ts.
		const serviceWithHooks = this.service as unknown as {
			hooks: { emitEvent?: (payload: Record<string, unknown>) => void };
		};
		const previous = serviceWithHooks.hooks.emitEvent;
		serviceWithHooks.hooks.emitEvent = (payload) => {
			previous?.(payload);
			const event = this.translate(payload);
			if (event) {
				this.bus.publish(event);
			}
		};
	}

	private translate(payload: Record<string, unknown>): TapEvent | null {
		const direction = stringField(payload.direction);
		const method = stringField(payload.method);
		if (!method) return null;

		const envelope = {
			id: `evt-${randomUUID()}`,
			occurredAt: new Date().toISOString(),
			identityAgentId: this.identityAgentId,
		};

		const peer = this.peerFromPayload(payload);

		switch (method) {
			case "message/send": {
				const text = stringField(payload.messageText) ?? "";
				const messageId = stringOrIdField(payload.id) ?? "";
				const conversationId = stringField(payload.conversationId) ?? "";
				const scope = stringField(payload.scope) ?? "default";
				if (direction === "incoming") {
					return {
						...envelope,
						type: "message.received",
						conversationId,
						peer,
						messageId,
						text,
						scope,
					};
				}
				if (direction === "outgoing") {
					return {
						...envelope,
						type: "message.sent",
						conversationId,
						peer,
						messageId,
						text,
						scope,
					};
				}
				return null;
			}
			case "action/request": {
				const conversationId = stringField(payload.conversationId) ?? "";
				const kind = parseActionKind(payload.actionKind) ?? "transfer";
				const requestId = stringOrIdField(payload.id) ?? "";
				const reqDirection = direction === "incoming" ? "inbound" : "outbound";
				return {
					...envelope,
					type: "action.requested",
					conversationId,
					peer,
					requestId,
					kind,
					payload,
					direction: reqDirection,
				};
			}
			case "action/result": {
				const conversationId = stringField(payload.conversationId) ?? "";
				const kind = parseActionKind(payload.actionKind) ?? "transfer";
				const requestId = stringOrIdField(payload.id) ?? "";
				const txHash = stringField(payload.txHash);
				return {
					...envelope,
					type: "action.completed",
					conversationId,
					requestId,
					kind,
					result: payload,
					...(txHash ? { txHash } : {}),
					completedAt: envelope.occurredAt,
				};
			}
			case "connection/result": {
				const connectionId = stringField(payload.connectionId) ?? "";
				return {
					...envelope,
					type: "connection.established",
					connectionId,
					peer,
				};
			}
			default:
				return null;
		}
	}

	private peerFromPayload(payload: Record<string, unknown>): TapPeerRef {
		return {
			connectionId: stringField(payload.connectionId) ?? "",
			peerAgentId:
				typeof payload.from === "number"
					? payload.from
					: typeof payload.to === "number"
						? payload.to
						: 0,
			peerName: stringField(payload.peerName) ?? stringField(payload.fromName) ?? "",
			peerChain: stringField(payload.peerChain) ?? "",
		};
	}
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringOrIdField(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

function parseActionKind(value: unknown): "transfer" | "scheduling" | "grant" | undefined {
	if (value === "transfer" || value === "scheduling" || value === "grant") {
		return value;
	}
	return undefined;
}
