import { MessagesSquare } from "lucide-react";

export function EmptyState() {
	return (
		<div className="h-full grid place-items-center text-text-dim bg-bg-main">
			<div className="text-center max-w-sm px-6">
				<div className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-bg-elevated text-text-muted mb-4 border border-bg-divider">
					<MessagesSquare className="w-5 h-5" strokeWidth={1.5} />
				</div>
				<div className="text-sm font-semibold tracking-tight text-text-muted">
					Select a connection
				</div>
				<div className="text-[11.5px] text-text-faint mt-1.5 leading-relaxed">
					Your agent's conversations appear here in real time. Pick a peer on
					the left to follow along.
				</div>
			</div>
		</div>
	);
}
