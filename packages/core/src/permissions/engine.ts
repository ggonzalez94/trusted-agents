import type { Contact } from "../trust/types.js";
import type { PermissionResult } from "./types.js";

export class PermissionEngine {
	check(contact: Contact, scope: string): PermissionResult {
		const permission = this.getEffectivePermission(contact, scope);

		if (permission === null) {
			return { allowed: false, reason: "Unknown scope" };
		}

		if (permission === false) {
			return { allowed: false, reason: `Scope "${scope}" is denied` };
		}

		return { allowed: true };
	}

	getEffectivePermission(
		contact: Contact,
		scope: string,
	): boolean | Record<string, unknown> | null {
		if (!(scope in contact.permissions)) {
			return null;
		}
		return contact.permissions[scope] ?? null;
	}
}
