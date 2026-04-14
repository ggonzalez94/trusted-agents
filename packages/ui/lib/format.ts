/**
 * Display formatters for addresses, chain IDs, agent IDs, names, and times.
 * Pure functions — no side effects, no globals beyond the chain alias map.
 */

const CHAIN_NAMES: Record<string, string> = {
	"eip155:1": "ethereum",
	"eip155:10": "optimism",
	"eip155:8453": "base",
	"eip155:42161": "arbitrum",
	"eip155:167000": "taiko",
};

export function formatAddress(address: string): string {
	if (!address) return "";
	if (address.length <= 10) return address;
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatChain(caip2: string): string {
	return CHAIN_NAMES[caip2] ?? caip2;
}

export function formatAgentId(agentId: number): string {
	return `#${agentId}`;
}

export function formatInitials(name: string): string {
	if (!name) return "";
	const trimmed = name.trim();
	if (trimmed.length === 0) return "";
	if (trimmed.length === 1) return trimmed.toUpperCase();
	return trimmed.slice(0, 2).toUpperCase();
}

export function formatRelativeTime(
	isoString: string,
	now: Date = new Date(),
): string {
	const past = new Date(isoString);
	const diffMs = now.getTime() - past.getTime();
	const diffSec = Math.round(diffMs / 1000);

	if (diffSec < 30) return "just now";
	if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
	if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
	if (diffSec < 604800) return `${Math.round(diffSec / 86400)}d ago`;

	return past.toLocaleDateString();
}
