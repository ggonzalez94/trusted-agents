import type { RouteHandler } from "../router.js";
import { asRecord } from "../validation.js";

export interface CreateInviteRequest {
	expiresInSeconds?: number;
}

export interface CreateInviteResult {
	url: string;
	expiresInSeconds: number;
}

export type InviteCreator = (request: CreateInviteRequest) => Promise<CreateInviteResult>;

function parseInviteBody(value: unknown): CreateInviteRequest {
	if (value === undefined || value === null) return {};
	const v = asRecord(value);
	if (!v) throw new Error("invites POST body must be an object");
	const raw = v.expiresInSeconds;
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		throw new Error("invites POST expiresInSeconds must be a number");
	}
	if (raw <= 0) {
		throw new Error("invites POST expiresInSeconds must be positive");
	}
	return { expiresInSeconds: raw };
}

/**
 * POST /api/invites — generate a signed TAP invite URL using the daemon's
 * configured signing provider. Mirrors `tap invite create`: validates the
 * optional expiry, delegates to the host's `createInvite` adapter, returns
 * `{ url, expiresInSeconds }`.
 */
export function createInvitesRoute(
	creator: InviteCreator,
): RouteHandler<unknown, CreateInviteResult> {
	return async (_params, body) => {
		const parsed = parseInviteBody(body);
		return await creator(parsed);
	};
}
