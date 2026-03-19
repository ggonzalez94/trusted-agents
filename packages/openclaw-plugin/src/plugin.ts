import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseTapOpenClawPluginConfig, tapOpenClawPluginConfigSchema } from "./config.js";
import { resolveOpenClawMainSessionKey } from "./main-session.js";
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
		const registry = new OpenClawTapRegistry(pluginConfig, api.logger, {
			sessionKey: resolveOpenClawMainSessionKey(api.config),
			system: api.runtime.system,
		});

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

		api.on("before_prompt_build", async (_event, _ctx) => {
			const notifications = registry.drainNotifications();
			if (notifications.length === 0) return;

			const lines = notifications.map((n) => {
				const prefix =
					n.type === "escalation" ? "ESCALATION" : n.type === "summary" ? "SUMMARY" : "INFO";
				return `- ${prefix}: ${n.oneLiner}`;
			});

			return {
				prependContext: `[TAP Notifications]\n${lines.join("\n")}`,
			};
		});
	},
};

export default plugin;
