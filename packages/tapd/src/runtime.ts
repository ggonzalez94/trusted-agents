import type { TapEvent, TapMessagingService } from "trusted-agents-core";
import type { EventBus } from "./event-bus.js";

export interface TapdRuntimeOptions {
	service: TapMessagingService;
	identityAgentId: number;
	bus: EventBus;
}

/**
 * Thin wrapper that bridges a `TapMessagingService` into the tapd
 * `EventBus`. The underlying service now emits strongly-typed
 * `TapEvent`s directly via the `onTypedEvent` hook, so this runtime
 * just forwards them — no field-name guessing, no `Record<string, unknown>`
 * → typed translation layer.
 */
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

	get bound(): { identityAgentId: number } {
		return { identityAgentId: this.identityAgentId };
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
		// Chain onto the existing onTypedEvent hook so host adapters that also
		// register a typed listener still see the event.
		const serviceWithHooks = this.service as unknown as {
			hooks: { onTypedEvent?: (event: TapEvent) => void };
		};
		const previous = serviceWithHooks.hooks.onTypedEvent;
		serviceWithHooks.hooks.onTypedEvent = (event) => {
			previous?.(event);
			this.bus.publish(event);
		};
	}
}
