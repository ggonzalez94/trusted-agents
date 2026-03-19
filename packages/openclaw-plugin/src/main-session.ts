import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type OpenClawSessionConfig = Pick<OpenClawPluginApi["config"], "agents" | "session">;

const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";
const VALID_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_TOKEN_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

export function resolveOpenClawMainSessionKey(config: OpenClawSessionConfig): string {
	if (config.session?.scope === "global") {
		return "global";
	}

	const agents = config.agents?.list ?? [];
	const defaultAgentId = agents.find((agent) => agent?.default)?.id;
	const fallbackAgentId = agents[0]?.id;

	return `agent:${normalizeAgentId(defaultAgentId ?? fallbackAgentId)}:${normalizeMainKey(
		config.session?.mainKey,
	)}`;
}

function normalizeAgentId(value: string | undefined): string {
	const trimmed = value?.trim() ?? "";
	if (!trimmed) {
		return DEFAULT_AGENT_ID;
	}
	if (VALID_TOKEN_RE.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	return (
		trimmed
			.toLowerCase()
			.replace(INVALID_TOKEN_RE, "-")
			.replace(LEADING_DASH_RE, "")
			.replace(TRAILING_DASH_RE, "")
			.slice(0, 64) || DEFAULT_AGENT_ID
	);
}

function normalizeMainKey(value: string | undefined): string {
	const trimmed = value?.trim() ?? "";
	return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}
