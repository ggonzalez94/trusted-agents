import {
	type ChainConfig,
	type ExecutionCall,
	type ExecutionPreview,
	type ExecutionSendResult,
	type TrustedAgentsConfig,
	ensureExecutionReady as ensureCoreExecutionReady,
	executeContractCalls as executeCoreContractCalls,
	getExecutionPreview as getCoreExecutionPreview,
} from "trusted-agents-core";

export type { ExecutionCall, ExecutionPreview, ExecutionSendResult } from "trusted-agents-core";

export async function getExecutionPreview(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	options?: { requireProvider?: boolean },
): Promise<ExecutionPreview> {
	return await getCoreExecutionPreview(config, chainConfig, options);
}

export async function ensureExecutionReady(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	options?: {
		preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode">;
		deployEip4337Account?: boolean;
	},
): Promise<void> {
	return await ensureCoreExecutionReady(config, chainConfig, options);
}

export async function executeContractCalls(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	calls: ExecutionCall[],
	options?: {
		preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode">;
	},
): Promise<ExecutionSendResult> {
	return await executeCoreContractCalls(config, chainConfig, calls, options);
}
