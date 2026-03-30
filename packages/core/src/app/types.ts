import type { Contact } from "../trust/types.js";
import type { PermissionGrant } from "../permissions/types.js";

// ── Read-only contact view for apps ──

export type ReadonlyContact = Readonly<Contact>;

// ── App-scoped storage ──

export interface TapAppStorage {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix?: string): Promise<Record<string, unknown>>;
}

// ── Payment primitives ──

export interface PaymentRequestParams {
	asset: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

export interface TransferExecuteParams {
	asset: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

// ── App event ──

export interface TapAppEvent {
	type: string;
	summary: string;
	data?: Record<string, unknown>;
}

// ── Action context (what apps receive) ──

export interface TapActionContext {
	self: {
		agentId: number;
		chain: string;
		address: `0x${string}`;
	};
	peer: {
		contact: ReadonlyContact;
		grantsFromPeer: PermissionGrant[];
		grantsToPeer: PermissionGrant[];
	};
	payload: Record<string, unknown>;
	text?: string;
	messaging: {
		reply(text: string): Promise<void>;
		send(peerId: number, text: string): Promise<void>;
	};
	payments: {
		request(params: PaymentRequestParams): Promise<{ requestId: string }>;
		execute(params: TransferExecuteParams): Promise<{ txHash: `0x${string}` }>;
	};
	storage: TapAppStorage;
	events: {
		emit(event: TapAppEvent): void;
	};
	log: {
		append(entry: { text: string; direction: "inbound" | "outbound" }): Promise<void>;
	};
}

// ── Action result ──

export interface TapActionResult {
	success: boolean;
	data?: Record<string, unknown>;
	error?: { code: string; message: string };
}

// ── Action handler ──

export interface TapActionHandler {
	inputSchema?: Record<string, unknown>;
	handler: (ctx: TapActionContext) => Promise<TapActionResult>;
}

// ── App definition ──

export interface TapApp {
	id: string;
	name: string;
	version: string;
	actions: Record<string, TapActionHandler>;
	grantScopes?: string[];
}

// ── Helper to define an app with type checking ──

export function defineTapApp(app: TapApp): TapApp {
	return app;
}
