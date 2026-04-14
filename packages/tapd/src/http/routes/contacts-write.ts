import type { Contact, ITrustStore, TapMessagingService } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { requireParam } from "../validation.js";

interface RevokeBody {
	reason?: string;
}

function isRevokeBody(value: unknown): value is RevokeBody {
	if (value === undefined || value === null) return true;
	if (typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.reason !== undefined && typeof v.reason !== "string") return false;
	return true;
}

export interface ContactsWriteRoutes {
	revoke: RouteHandler<unknown, { revoked: true; connectionId: string; peer: string }>;
}

/**
 * POST /api/contacts/:connectionId/revoke — best-effort delivery of
 * `connection/revoke` to the peer followed by a local contact removal. Mirrors
 * the existing `tap contacts remove` CLI command.
 */
export function createContactsWriteRoutes(
	service: TapMessagingService,
	trustStore: ITrustStore,
): ContactsWriteRoutes {
	return {
		revoke: async (params, body) => {
			const connectionId = requireParam(params, "connectionId");
			if (!isRevokeBody(body)) {
				throw new Error("revoke body must be { reason?: string } or empty");
			}
			const contacts = await trustStore.getContacts();
			const contact = contacts.find((c: Contact) => c.connectionId === connectionId);
			if (!contact) {
				throw new Error(`Contact not found: ${connectionId}`);
			}
			await service.revokeConnection(contact, body?.reason);
			await trustStore.removeContact(connectionId);
			return {
				revoked: true,
				connectionId,
				peer: contact.peerDisplayName,
			};
		},
	};
}
