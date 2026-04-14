import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { formatInitials } from "@/lib/format";
import type { Contact } from "@/lib/types";

interface DmListItemProps {
	contact: Contact;
	active: boolean;
	unread: boolean;
	onSelect: (connectionId: string) => void;
}

export function DmListItem({ contact, active, unread, onSelect }: DmListItemProps) {
	return (
		<button
			type="button"
			onClick={() => onSelect(contact.connectionId)}
			className={cn(
				"group w-full px-3 py-2 mx-1.5 rounded-md flex items-center gap-2.5 text-sm transition-colors",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/60",
				active ? "bg-bg-elevated text-text" : "text-text-muted hover:bg-bg-subtle hover:text-text",
			)}
		>
			<Avatar
				initials={formatInitials(contact.peerDisplayName)}
				size="sm"
				variant={active ? "primary" : "neutral"}
			/>
			<span
				className={cn(
					"flex-1 text-left truncate tracking-tight",
					unread && !active && "text-text font-semibold",
				)}
			>
				{contact.peerDisplayName}
			</span>
			{unread && (
				<span className="w-1.5 h-1.5 rounded-full bg-accent-primary shadow-[0_0_8px_0_rgba(99,102,241,0.7)]" />
			)}
		</button>
	);
}
