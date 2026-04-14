import { getToken } from "./token";
import type { Contact, ConversationLog, Identity, PendingItem } from "./types";

/**
 * Typed REST client for the tapd HTTP API. Reads the bearer token from
 * `sessionStorage` on every request and sets the `Authorization` header.
 * Throws `TapdApiError` on non-2xx responses, surfacing the structured error
 * code/message tapd emits.
 */

export interface TapdErrorPayload {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

export class TapdApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(
		code: string,
		message: string,
		status: number,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "TapdApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export class TapdClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	getIdentity(): Promise<Identity> {
		return this.get<Identity>("/api/identity");
	}

	listContacts(): Promise<Contact[]> {
		return this.get<Contact[]>("/api/contacts");
	}

	getContact(connectionId: string): Promise<Contact | null> {
		return this.get<Contact | null>(
			`/api/contacts/${encodeURIComponent(connectionId)}`,
		);
	}

	listConversations(): Promise<ConversationLog[]> {
		return this.get<ConversationLog[]>("/api/conversations");
	}

	getConversation(id: string): Promise<ConversationLog | null> {
		return this.get<ConversationLog | null>(
			`/api/conversations/${encodeURIComponent(id)}`,
		);
	}

	markConversationRead(id: string): Promise<{ ok: true }> {
		return this.post<{ ok: true }>(
			`/api/conversations/${encodeURIComponent(id)}/mark-read`,
			{},
		);
	}

	listPending(): Promise<PendingItem[]> {
		return this.get<PendingItem[]>("/api/pending");
	}

	approvePending(id: string, note?: string): Promise<{ resolved: true }> {
		return this.post<{ resolved: true }>(
			`/api/pending/${encodeURIComponent(id)}/approve`,
			note ? { note } : {},
		);
	}

	denyPending(id: string, reason?: string): Promise<{ resolved: true }> {
		return this.post<{ resolved: true }>(
			`/api/pending/${encodeURIComponent(id)}/deny`,
			reason ? { reason } : {},
		);
	}

	private async get<T>(path: string): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "GET",
			headers: this.headers(),
		});
		return this.parse<T>(response);
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return this.parse<T>(response);
	}

	private headers(): Record<string, string> {
		const token = getToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	private async parse<T>(response: Response): Promise<T> {
		const text = await response.text();
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			body = undefined;
		}
		if (!response.ok) {
			const error = (body as { error?: TapdErrorPayload } | undefined)?.error;
			throw new TapdApiError(
				error?.code ?? "unknown_error",
				error?.message ?? response.statusText,
				response.status,
				error?.details,
			);
		}
		return body as T;
	}
}
