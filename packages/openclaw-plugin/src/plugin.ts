import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseTapOpenClawPluginConfig, tapOpenClawPluginConfigSchema } from "./config.js";
import { OpenClawTapRegistry } from "./registry.js";
import { createTapGatewayTool } from "./tool.js";

const plugin = {
	id: "trusted-agents-tap",
	name: "Trusted Agents TAP",
	description:
		"Run the Trusted Agents Protocol inside OpenClaw Gateway with a background TAP runtime and TAP Gateway tool.",
	configSchema: tapOpenClawPluginConfigSchema,
	register(api: OpenClawPluginApi) {
		const pluginConfig = parseTapOpenClawPluginConfig(api.pluginConfig);
		const registry = new OpenClawTapRegistry(pluginConfig, api.logger);

		api.registerService({
			id: "trusted-agents-tap-runtime",
			start: async () => {
				await registry.start();
			},
			stop: async () => {
				await registry.stop();
			},
		});

		api.registerTool(createTapGatewayTool(registry));
	},
};

export default plugin;
