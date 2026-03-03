import type { AgentCard } from "../protocol/types.js";
import type { ServerConfig } from "./types.js";

export function generateAgentCard(config: ServerConfig): AgentCard {
	return {
		name: config.agentName,
		description: config.agentDescription,
		url: config.agentUrl,
		version: "0.3.0",
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: config.capabilities.map((capability) => ({
			id: capability,
			name: capability,
			description: `Trusted Agents capability: ${capability}`,
			tags: ["trusted-agents"],
		})),
		capabilities: config.capabilities,
		protocols: ["a2a/v0.3.0", "trusted-agents/v1.0"],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: config.agentAddress,
			capabilities: config.capabilities,
		},
	};
}
