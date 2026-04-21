import type { Contact, ITrustStore, TapMessagingService } from "trusted-agents-core";
import { HttpError } from "../errors.js";
import type { RouteHandler } from "../router.js";
import { isOptionalReasonBody, requireBody, requireParam } from "../validation.js";

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
			requireBody(body, isOptionalReasonBody, "revoke body must be { reason?: string } or empty");
			const contacts = await trustStore.getContacts();
			const contact = contacts.find((c: Contact) => c.connectionId === connectionId);
			if (!contact) {
				throw new HttpError(404, "contact_not_found", `Contact not found: ${connectionId}`);
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
