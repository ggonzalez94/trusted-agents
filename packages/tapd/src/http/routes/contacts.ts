import type { Contact, ITrustStore } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface ContactsRoutes {
	list: RouteHandler<unknown, Contact[]>;
	get: RouteHandler<unknown, Contact | null>;
}

export function createContactsRoutes(store: ITrustStore): ContactsRoutes {
	return {
		list: async () => await store.getContacts(),
		get: async (params) => {
			const id = params.connectionId;
			if (!id) return null;
			return await store.getContact(id);
		},
	};
}
