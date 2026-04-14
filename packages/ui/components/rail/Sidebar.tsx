import type { Contact, ConversationLog, Identity } from "@/lib/types";
import { ChannelsPreview } from "./ChannelsPreview";
import { DmList } from "./DmList";
import { IdentityHeader } from "./IdentityHeader";

interface SidebarProps {
	identity: Identity;
	contacts: Contact[];
	conversations: ConversationLog[];
	selectedConnectionId: string | null;
	onSelect: (connectionId: string) => void;
}

export function Sidebar({
	identity,
	contacts,
	conversations,
	selectedConnectionId,
	onSelect,
}: SidebarProps) {
	return (
		<aside className="w-64 bg-bg-rail border-r border-bg-border flex flex-col flex-shrink-0">
			<IdentityHeader identity={identity} />
			<div className="flex-1 overflow-y-auto py-2">
				<DmList
					contacts={contacts}
					conversations={conversations}
					selectedConnectionId={selectedConnectionId}
					onSelect={onSelect}
				/>
				<ChannelsPreview />
			</div>
			<div className="px-4 py-3 border-t border-bg-border text-[10px] font-mono uppercase tracking-[0.18em] text-text-ghost flex items-center justify-between">
				<span>tapd</span>
				<span className="text-text-faint normal-case tracking-normal italic">
					local
				</span>
			</div>
		</aside>
	);
}
