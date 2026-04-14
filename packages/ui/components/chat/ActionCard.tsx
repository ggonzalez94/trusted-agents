import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { ActionKind } from "@/lib/types";
import { CalendarDays, DollarSign, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

export type ActionCardStatus = "pending" | "completed" | "failed";

export interface ActionRow {
	label: string;
	value: string;
	mono?: boolean;
}

interface ActionCardProps {
	kind: ActionKind;
	title: string;
	subtitle?: string;
	rows?: ActionRow[];
	status?: ActionCardStatus;
	statusText?: string;
	outgoing?: boolean;
	onApprove?: () => void | Promise<void>;
	onDeny?: () => void | Promise<void>;
	approving?: boolean;
}

interface KindMeta {
	icon: ReactNode;
	label: string;
}

const KIND_META: Record<ActionKind, KindMeta> = {
	transfer: {
		icon: <DollarSign className="w-3.5 h-3.5" strokeWidth={2.4} />,
		label: "Transfer request",
	},
	scheduling: {
		icon: <CalendarDays className="w-3.5 h-3.5" strokeWidth={2.4} />,
		label: "Meeting proposal",
	},
	grant: {
		icon: <ShieldCheck className="w-3.5 h-3.5" strokeWidth={2.4} />,
		label: "Grant request",
	},
};

const STATUS_STYLES: Record<ActionCardStatus, string> = {
	pending: "bg-amber-500/10 text-amber-300 border border-amber-400/30",
	completed: "bg-emerald-500/10 text-emerald-300 border border-emerald-400/30",
	failed: "bg-red-500/10 text-red-300 border border-red-400/30",
};

const KIND_ACCENT: Record<ActionKind, string> = {
	transfer: "bg-emerald-500/10 text-emerald-300 border-emerald-400/25",
	scheduling: "bg-sky-500/10 text-sky-300 border-sky-400/25",
	grant: "bg-violet-500/10 text-violet-300 border-violet-400/25",
};

export function ActionCard({
	kind,
	title,
	subtitle,
	rows,
	status,
	statusText,
	outgoing,
	onApprove,
	onDeny,
	approving,
}: ActionCardProps) {
	const meta = KIND_META[kind];
	const showActions = !!(onApprove || onDeny);
	return (
		<Card className={cn("max-w-[420px] p-4", outgoing ? "ml-auto mr-12" : "ml-12")}>
			<div className="flex items-center gap-2 mb-3">
				<span
					className={cn(
						"inline-flex w-6 h-6 items-center justify-center rounded-md border",
						KIND_ACCENT[kind],
					)}
				>
					{meta.icon}
				</span>
				<span className="text-[10px] uppercase tracking-[0.18em] text-text-muted font-mono">
					{meta.label}
				</span>
			</div>

			<div className="text-[15px] font-semibold tracking-tight text-text mb-0.5">{title}</div>
			{subtitle && (
				<div className="text-[11.5px] text-text-muted mb-3 leading-snug">{subtitle}</div>
			)}

			{rows && rows.length > 0 && (
				<dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 mt-3 text-[11.5px]">
					{rows.map((row) => (
						<div key={row.label} className="contents">
							<dt className="text-text-dim uppercase tracking-wider text-[10px] font-mono pt-[2px]">
								{row.label}
							</dt>
							<dd
								className={cn(
									"text-text text-right",
									row.mono !== false && "font-mono text-[11px]",
								)}
							>
								{row.value}
							</dd>
						</div>
					))}
				</dl>
			)}

			{status && statusText && (
				<div className="mt-3.5">
					<span
						className={cn(
							"inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[10.5px] font-mono uppercase tracking-wider",
							STATUS_STYLES[status],
						)}
					>
						{statusText}
					</span>
				</div>
			)}

			{showActions && (
				<div className="flex gap-2 mt-4 pt-3.5 border-t border-bg-divider">
					{onApprove && (
						<Button
							variant="primary"
							size="sm"
							className="flex-1"
							disabled={approving}
							onClick={() => {
								void onApprove();
							}}
						>
							{approving ? "Approving…" : "Approve"}
						</Button>
					)}
					{onDeny && (
						<Button
							variant="ghost"
							size="sm"
							className="flex-1"
							disabled={approving}
							onClick={() => {
								void onDeny();
							}}
						>
							Decline
						</Button>
					)}
				</div>
			)}
		</Card>
	);
}
