import type { Contact, ConversationLog } from "@/lib/types";
import { DmListItem } from "./DmListItem";

interface DmListProps {
	contacts: Contact[];
	conversations: ConversationLog[];
	selectedConnectionId: string | null;
	onSelect: (connectionId: string) => void;
}

function isUnread(log: ConversationLog | undefined): boolean {
	if (!log) return false;
	if (!log.lastReadAt) return true;
	return log.lastReadAt < log.lastMessageAt;
}

export function DmList({
	contacts,
	conversations,
	selectedConnectionId,
	onSelect,
}: DmListProps) {
	const conversationByConnection = new Map<string, ConversationLog>();
	for (const conversation of conversations) {
		conversationByConnection.set(conversation.connectionId, conversation);
	}

	const activeContacts = contacts.filter((c) => c.status === "active");

	return (
		<div>
			<div className="px-4 pt-4 pb-2 text-[10px] uppercase tracking-[0.18em] text-text-faint font-mono flex items-center justify-between">
				<span>Direct</span>
				<span className="text-text-ghost">{activeContacts.length}</span>
			</div>
			<div className="space-y-0.5">
				{activeContacts.length === 0 ? (
					<div className="px-4 py-3 text-xs text-text-faint italic">
						No connections yet
					</div>
				) : (
					activeContacts.map((contact) => (
						<DmListItem
							key={contact.connectionId}
							contact={contact}
							active={selectedConnectionId === contact.connectionId}
							unread={isUnread(conversationByConnection.get(contact.connectionId))}
							onSelect={onSelect}
						/>
					))
				)}
			</div>
		</div>
	);
}
