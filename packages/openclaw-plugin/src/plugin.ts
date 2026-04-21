import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { toErrorMessage } from "trusted-agents-core";
import { parseTapOpenClawPluginConfig, tapOpenClawPluginConfigSchema } from "./config.js";
import { EscalationWatcher } from "./escalation-watcher.js";
import { drainAndFormatNotifications } from "./notifications-drain.js";
import { OpenClawTapdClient } from "./tapd-client.js";
import { createTapGatewayTool } from "./tool.js";

const ESCALATION_SESSION_KEY = "tap:escalation";

const plugin = {
	id: "trusted-agents-tap",
	name: "Trusted Agents TAP",
	description: "Run the Trusted Agents Protocol inside OpenClaw Gateway via the local tapd daemon.",
	configSchema: tapOpenClawPluginConfigSchema,
	register(api: OpenClawPluginApi) {
		const pluginConfig = parseTapOpenClawPluginConfig(api.pluginConfig);
		const client = new OpenClawTapdClient({
			dataDir: pluginConfig.dataDir,
			socketPath: pluginConfig.tapdSocketPath,
		});

		const escalationWatcher = new EscalationWatcher({
			socketPath: client.socketPathPublic,
			logger: { warn: (msg) => api.logger.warn(`[trusted-agents-tap] ${msg}`) },
			onEscalation: (event) => {
				try {
					api.runtime.system.enqueueSystemEvent(`TAP escalation: ${event.type}`, {
						sessionKey: ESCALATION_SESSION_KEY,
						contextKey: "tap:escalation",
					});
					api.runtime.system.requestHeartbeatNow({
						reason: "hook:tap-escalation",
						coalesceMs: 2000,
						sessionKey: ESCALATION_SESSION_KEY,
					});
				} catch (error: unknown) {
					api.logger.warn(
						`[trusted-agents-tap] Failed to wake agent on escalation: ${toErrorMessage(error)}`,
					);
				}
			},
		});

		api.registerService({
			id: "trusted-agents-tap-runtime",
			start: async () => {
				// Start the watcher unconditionally. Its built-in reconnect loop
				// (see escalation-watcher.ts handleEnd) will attach once tapd
				// comes up, so the agent can still wake on escalations even if
				// Gateway boots before tapd. Gating on the one-shot health
				// check here leaves the agent blind to escalations until the
				// plugin service is restarted.
				escalationWatcher.start();
				try {
					await client.health();
				} catch (error: unknown) {
					api.logger.error(
						`[trusted-agents-tap] tapd is not reachable: ${toErrorMessage(error)}. Run 'tap daemon start' to launch it. The TAP gateway tool will return errors until then.`,
					);
				}
			},
			stop: async () => {
				escalationWatcher.stop();
			},
		});

		api.registerTool(createTapGatewayTool(client));

		api.on("before_prompt_build", async () => {
			try {
				const result = await drainAndFormatNotifications(client);
				return result ?? undefined;
			} catch (error: unknown) {
				api.logger.warn(`[trusted-agents-tap] notification drain failed: ${toErrorMessage(error)}`);
				return undefined;
			}
		});
	},
};

export default plugin;
