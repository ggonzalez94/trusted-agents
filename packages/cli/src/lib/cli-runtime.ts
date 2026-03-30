import type {
	IAgentResolver,
	IRequestJournal,
	ITrustStore,
	SigningProvider,
	TapMessagingService,
	TrustedAgentsConfig,
} from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { type CliContextWithTransport, buildContextWithTransport } from "./context.js";
import {
	type CliTapServiceHooks,
	type CliTapServiceOptions,
	createCliTapMessagingService,
} from "./tap-service.js";

export type { CliTapServiceHooks };

export interface CliRuntimeOptions {
	config: TrustedAgentsConfig;
	opts: GlobalOptions;
	emitEvents?: boolean;
	ownerLabel?: string;
	hooks?: CliTapServiceHooks;
}

/**
 * Thin runtime wrapper that composes a CLI context + TapMessagingService.
 *
 * Exposes the underlying service and commonly-needed context parts so that
 * command files can import one thing instead of manually wiring context and
 * service together.
 */
export interface CliRuntime {
	/** The composed TapMessagingService — use for all transport-active operations. */
	readonly service: TapMessagingService;

	/** The underlying context with transport — for direct access when needed. */
	readonly context: CliContextWithTransport;

	// Convenience accessors for commonly-used context parts
	readonly trustStore: ITrustStore;
	readonly resolver: IAgentResolver;
	readonly signingProvider: SigningProvider;
	readonly requestJournal: IRequestJournal;
	readonly config: TrustedAgentsConfig;
}

/**
 * Create a CLI runtime that wires context, transport, and service together.
 *
 * This replaces the manual `buildContextWithTransport` + `createCliTapMessagingService`
 * composition that each command previously did inline.
 */
export function createCliRuntime(options: CliRuntimeOptions): CliRuntime {
	const { config, opts, emitEvents, ownerLabel, hooks } = options;

	const context = buildContextWithTransport(config);

	const serviceOptions: CliTapServiceOptions = {
		emitEvents,
		ownerLabel,
		hooks,
	};

	const service = createCliTapMessagingService(context, opts, serviceOptions);

	return {
		service,
		context,
		trustStore: context.trustStore,
		resolver: context.resolver,
		signingProvider: context.signingProvider,
		requestJournal: context.requestJournal,
		config,
	};
}
