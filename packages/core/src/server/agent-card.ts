import type { AgentCard } from "../protocol/types.js";
import type { ServerConfig } from "./types.js";

export function generateAgentCard(config: ServerConfig): AgentCard {
	return {
		name: config.agentName,
		description: config.agentDescription,
		url: config.agentUrl,
		capabilities: config.capabilities,
		protocols: ["a2a/v0.3.0", "trusted-agents/v1.0"],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: config.agentAddress,
			capabilities: config.capabilities,
		},
	};
}
