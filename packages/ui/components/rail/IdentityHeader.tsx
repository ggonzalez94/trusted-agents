import { Avatar } from "@/components/ui/avatar";
import { formatAgentId, formatChain, formatInitials } from "@/lib/format";
import type { Identity } from "@/lib/types";

interface IdentityHeaderProps {
	identity: Identity;
}

export function IdentityHeader({ identity }: IdentityHeaderProps) {
	const displayName = identity.displayName || "Agent";
	return (
		<div className="px-4 pt-5 pb-4 border-b border-bg-border">
			<div className="text-[10px] uppercase tracking-[0.18em] text-text-faint mb-3 font-mono">
				Operator
			</div>
			<div className="flex items-center gap-3">
				<Avatar initials={formatInitials(displayName)} size="lg" />
				<div className="min-w-0">
					<div className="text-sm font-semibold tracking-tight truncate text-text">
						{displayName}
					</div>
					<div className="text-[11px] text-text-dim font-mono mt-0.5">
						{formatAgentId(identity.agentId)}
						<span className="text-text-ghost mx-1.5">·</span>
						{formatChain(identity.chain)}
					</div>
				</div>
			</div>
		</div>
	);
}
