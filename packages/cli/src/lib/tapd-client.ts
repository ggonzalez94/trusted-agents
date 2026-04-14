import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	Contact,
	ConversationLog,
	PermissionGrantSet,
	SchedulingProposal,
	TapCancelMeetingResult,
	TapConnectResult,
	TapPendingRequest,
	TapPublishGrantSetResult,
	TapRequestFundsInput,
	TapRequestFundsResult,
	TapRequestGrantSetResult,
	TapRequestMeetingResult,
	TapSendMessageResult,
	TapSyncReport,
} from "trusted-agents-core";

const TOKEN_FILE = ".tapd-token";
const PORT_FILE = ".tapd.port";

/**
 * Thrown when the tapd port file or token file is missing/empty. Callers can
 * recover by either prompting the user to run `tap daemon start` or falling
 * back to a local-only path.
 */
export class TapdNotRunningError extends Error {
	constructor() {
		super("tapd is not running. Start it with: tap daemon start");
		this.name = "TapdNotRunningError";
	}
}

/**
 * Thrown for non-2xx responses from tapd. Mirrors the TapdApiError shape from
 * the web UI client so callers can surface tapd's structured error code/message.
 */
export class TapdClientError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "TapdClientError";
	}
}

export interface TapdConnectionInfo {
	baseUrl: string;
	token: string;
}

/**
 * Read the bound port and bearer token tapd writes into the data dir at start.
 * Throws `TapdNotRunningError` if either file is missing or empty.
 */
export async function discoverTapd(dataDir: string): Promise<TapdConnectionInfo> {
	let portRaw: string;
	try {
		portRaw = await readFile(join(dataDir, PORT_FILE), "utf-8");
	} catch {
		throw new TapdNotRunningError();
	}
	const port = Number.parseInt(portRaw.trim(), 10);
	if (!Number.isInteger(port) || port <= 0) {
		throw new TapdNotRunningError();
	}

	let token: string;
	try {
		token = (await readFile(join(dataDir, TOKEN_FILE), "utf-8")).trim();
	} catch {
		throw new TapdNotRunningError();
	}
	if (!token) {
		throw new TapdNotRunningError();
	}

	return { baseUrl: `http://127.0.0.1:${port}`, token };
}

/**
 * Returns connection info if tapd appears to be running, otherwise null.
 * Useful for commands that route through tapd opportunistically and fall back
 * to direct file mutation when tapd is offline.
 */
export async function tryDiscoverTapd(dataDir: string): Promise<TapdConnectionInfo | null> {
	try {
		return await discoverTapd(dataDir);
	} catch (err) {
		if (err instanceof TapdNotRunningError) return null;
		throw err;
	}
}

export interface TransferRequestBody {
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
}

export interface TransferResultBody {
	txHash: `0x${string}`;
}

export interface DaemonHealth {
	status: "ok";
	version: string;
	uptime: number;
	transportConnected: boolean;
	lastSyncAt?: string;
}

export interface IdentityResponse {
	agentId: number;
	chain: string;
	address: string;
	displayName: string;
	dataDir: string;
}

/**
 * Typed HTTP client for the tapd local API. Methods mirror the route surface
 * created in `packages/tapd/src/http/routes/`. Construct with
 * `TapdClient.forDataDir(dataDir)` so the bearer token is picked up
 * automatically.
 */
export class TapdClient {
	constructor(private readonly info: TapdConnectionInfo) {}

	static async forDataDir(dataDir: string): Promise<TapdClient> {
		return new TapdClient(await discoverTapd(dataDir));
	}

	get baseUrl(): string {
		return this.info.baseUrl;
	}

	get token(): string {
		return this.info.token;
	}

	// ── Reads ────────────────────────────────────────────────────────────────

	getIdentity(): Promise<IdentityResponse> {
		return this.get<IdentityResponse>("/api/identity");
	}

	listContacts(): Promise<Contact[]> {
		return this.get<Contact[]>("/api/contacts");
	}

	getContact(connectionId: string): Promise<Contact | null> {
		return this.get<Contact | null>(`/api/contacts/${encodeURIComponent(connectionId)}`);
	}

	listConversations(): Promise<ConversationLog[]> {
		return this.get<ConversationLog[]>("/api/conversations");
	}

	getConversation(id: string): Promise<ConversationLog | null> {
		return this.get<ConversationLog | null>(`/api/conversations/${encodeURIComponent(id)}`);
	}

	markConversationRead(id: string): Promise<{ ok: true }> {
		return this.post<{ ok: true }>(`/api/conversations/${encodeURIComponent(id)}/mark-read`, {});
	}

	listPending(): Promise<TapPendingRequest[]> {
		return this.get<TapPendingRequest[]>("/api/pending");
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

	// ── Writes ───────────────────────────────────────────────────────────────

	sendMessage(input: {
		peer: string;
		text: string;
		scope?: string;
	}): Promise<TapSendMessageResult> {
		return this.post<TapSendMessageResult>("/api/messages", input);
	}

	connect(input: { inviteUrl: string; waitMs?: number }): Promise<TapConnectResult> {
		return this.post<TapConnectResult>("/api/connect", input);
	}

	transfer(input: TransferRequestBody): Promise<TransferResultBody> {
		return this.post<TransferResultBody>("/api/transfers", input);
	}

	requestFunds(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return this.post<TapRequestFundsResult>("/api/funds-requests", input);
	}

	requestMeeting(input: {
		peer: string;
		proposal: SchedulingProposal;
	}): Promise<TapRequestMeetingResult> {
		return this.post<TapRequestMeetingResult>("/api/meetings", input);
	}

	respondMeeting(
		schedulingId: string,
		input: { approve: boolean; reason?: string },
	): Promise<{
		resolved: true;
		schedulingId: string;
		requestId: string;
		approve: boolean;
		report: TapSyncReport;
	}> {
		return this.post(`/api/meetings/${encodeURIComponent(schedulingId)}/respond`, input);
	}

	cancelMeeting(schedulingId: string, reason?: string): Promise<TapCancelMeetingResult> {
		return this.post<TapCancelMeetingResult>(
			`/api/meetings/${encodeURIComponent(schedulingId)}/cancel`,
			reason ? { reason } : {},
		);
	}

	publishGrants(input: {
		peer: string;
		grantSet: PermissionGrantSet;
		note?: string;
	}): Promise<TapPublishGrantSetResult> {
		return this.post<TapPublishGrantSetResult>("/api/grants/publish", input);
	}

	requestGrants(input: {
		peer: string;
		grantSet: PermissionGrantSet;
		note?: string;
	}): Promise<TapRequestGrantSetResult> {
		return this.post<TapRequestGrantSetResult>("/api/grants/request", input);
	}

	revokeContact(
		connectionId: string,
		reason?: string,
	): Promise<{ revoked: true; connectionId: string; peer: string }> {
		return this.post(
			`/api/contacts/${encodeURIComponent(connectionId)}/revoke`,
			reason ? { reason } : {},
		);
	}

	// ── Daemon control ──────────────────────────────────────────────────────

	health(): Promise<DaemonHealth> {
		return this.get<DaemonHealth>("/daemon/health");
	}

	triggerSync(): Promise<{ ok: true; report?: TapSyncReport }> {
		return this.post<{ ok: true; report?: TapSyncReport }>("/daemon/sync", {});
	}

	shutdown(): Promise<{ ok: true }> {
		return this.post<{ ok: true }>("/daemon/shutdown", {});
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private async get<T>(path: string): Promise<T> {
		const response = await fetch(`${this.info.baseUrl}${path}`, {
			method: "GET",
			headers: this.headers(),
		});
		return await this.parse<T>(response);
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const response = await fetch(`${this.info.baseUrl}${path}`, {
			method: "POST",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		return await this.parse<T>(response);
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.info.token}` };
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
			const errPayload = (
				body as
					| { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
					| undefined
			)?.error;
			throw new TapdClientError(
				errPayload?.code ?? "unknown_error",
				errPayload?.message ?? response.statusText,
				response.status,
				errPayload?.details,
			);
		}
		return body as T;
	}
}
