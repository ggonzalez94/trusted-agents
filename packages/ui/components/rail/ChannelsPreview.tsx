const PLACEHOLDER_CHANNELS = ["lunch-pool", "ops-standup"];

export function ChannelsPreview() {
	return (
		<div>
			<div className="px-4 pt-5 pb-2 text-[10px] uppercase tracking-[0.18em] text-text-faint font-mono flex items-center justify-between">
				<span>Channels</span>
				<span className="text-text-ghost normal-case tracking-normal text-[10px] italic">soon</span>
			</div>
			<div className="space-y-0.5 opacity-40 pointer-events-none select-none">
				{PLACEHOLDER_CHANNELS.map((name) => (
					<div key={name} className="mx-1.5 px-3 py-2 rounded-md flex items-center gap-2.5 text-sm">
						<div className="w-6 h-6 rounded-md bg-bg-elevated text-text-dim flex items-center justify-center text-[11px] font-mono font-semibold">
							#
						</div>
						<span className="text-text-faint tracking-tight">{name}</span>
					</div>
				))}
			</div>
		</div>
	);
}
