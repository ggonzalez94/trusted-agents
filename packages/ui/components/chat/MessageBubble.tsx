import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";

interface MessageBubbleProps {
	text: string;
	timestamp: string;
	direction: "incoming" | "outgoing";
	authorInitials: string;
}

export function MessageBubble({
	text,
	timestamp,
	direction,
	authorInitials,
}: MessageBubbleProps) {
	const outgoing = direction === "outgoing";
	return (
		<div
			className={cn(
				"flex gap-3 max-w-[78%]",
				outgoing && "ml-auto flex-row-reverse",
			)}
		>
			<Avatar
				initials={authorInitials}
				size="md"
				variant={outgoing ? "warm" : "primary"}
			/>
			<div className={cn("min-w-0", outgoing && "text-right")}>
				<div
					className={cn(
						"px-4 py-2.5 rounded-bubble text-[13.5px] leading-[1.5] tracking-tight",
						"border",
						outgoing
							? "bg-accent-primary/10 text-text border-accent-primary/25 rounded-tr-sm"
							: "bg-bg-elevated text-text border-bg-divider rounded-tl-sm",
					)}
				>
					{text}
				</div>
				<div className="text-[10px] text-text-faint mt-1.5 font-mono uppercase tracking-wider">
					{timestamp}
				</div>
			</div>
		</div>
	);
}
