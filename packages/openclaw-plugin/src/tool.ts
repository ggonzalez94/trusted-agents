import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { normalizeGrantInput } from "trusted-agents-core";
import { isEthereumAddress } from "trusted-agents-core";
import type { OpenClawTapRegistry } from "./registry.js";

const ACTIONS = [
	"status",
	"sync",
	"restart",
	"create_invite",
	"connect",
	"send_message",
	"publish_grants",
	"request_grants",
	"request_funds",
	"request_meeting",
	"respond_meeting",
	"cancel_meeting",
	"list_pending",
	"resolve_pending",
] as const;

function stringEnum<T extends readonly string[]>(values: T, description: string) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		description,
	});
}

export const TapGatewayToolSchema = Type.Object(
	{
		action: stringEnum(ACTIONS, `Action to perform: ${ACTIONS.join(", ")}`),
		identity: Type.Optional(
			Type.String({
				description:
					"Configured TAP identity name. Required when more than one identity is configured.",
			}),
		),
		peer: Type.Optional(Type.String({ description: "Peer name or agent ID" })),
		inviteUrl: Type.Optional(Type.String({ description: "Trusted Agents invite URL" })),
		text: Type.Optional(Type.String({ description: "Message text" })),
		scope: Type.Optional(Type.String({ description: "TAP message scope" })),
		note: Type.Optional(Type.String({ description: "Optional operator note" })),
		grantSet: Type.Optional(
			Type.Unknown({
				description: "Grant array or tap-grants/v1 object",
			}),
		),
		requestId: Type.Optional(Type.String({ description: "Pending TAP request ID" })),
		approve: Type.Optional(Type.Boolean({ description: "Approve or reject the pending request" })),
		asset: Type.Optional(
			Type.Union([Type.Literal("native"), Type.Literal("usdc")], {
				description: "Requested transfer asset",
			}),
		),
		amount: Type.Optional(Type.String({ description: "Transfer amount as a string" })),
		chain: Type.Optional(Type.String({ description: "CAIP-2 chain ID override" })),
		toAddress: Type.Optional(Type.String({ description: "Recipient address for fund requests" })),
		expiresInSeconds: Type.Optional(
			Type.Number({ description: "Invite expiry in seconds", minimum: 1 }),
		),
		title: Type.Optional(Type.String({ description: "Meeting title" })),
		duration: Type.Optional(
			Type.Number({ description: "Meeting duration in minutes", minimum: 1 }),
		),
		preferred: Type.Optional(
			Type.String({ description: "Preferred meeting time in ISO 8601 format" }),
		),
		location: Type.Optional(Type.String({ description: "Optional meeting location" })),
		schedulingId: Type.Optional(Type.String({ description: "Scheduling request ID" })),
		meetingAction: Type.Optional(
			Type.Union([Type.Literal("accept"), Type.Literal("reject")], {
				description: "Response action for a meeting request (accept or reject)",
			}),
		),
		reason: Type.Optional(Type.String({ description: "Optional reason for rejection or cancellation" })),
	},
	{ additionalProperties: false },
);

interface TapGatewayToolParams {
	action: (typeof ACTIONS)[number];
	identity?: string;
	peer?: string;
	inviteUrl?: string;
	text?: string;
	scope?: string;
	note?: string;
	grantSet?: unknown;
	requestId?: string;
	approve?: boolean;
	asset?: "native" | "usdc";
	amount?: string;
	chain?: string;
	toAddress?: string;
	expiresInSeconds?: number;
	title?: string;
	duration?: number;
	preferred?: string;
	location?: string;
	schedulingId?: string;
	meetingAction?: "accept" | "reject";
	reason?: string;
}

export function createTapGatewayTool(registry: OpenClawTapRegistry): AnyAgentTool {
	return {
		name: "tap_gateway",
		label: "TAP Gateway",
		description:
			"Operate the Trusted Agents Protocol inside OpenClaw Gateway. Use this when the TAP OpenClaw plugin is installed for status, sync, connect, messaging, grant updates, fund requests, and pending approval resolution.",
		parameters: TapGatewayToolSchema,
		async execute(_toolCallId, params) {
			return json(await executeTapGatewayAction(registry, params as TapGatewayToolParams));
		},
	} as AnyAgentTool;
}

async function executeTapGatewayAction(
	registry: OpenClawTapRegistry,
	params: TapGatewayToolParams,
): Promise<unknown> {
	switch (params.action) {
		case "status":
			return await registry.status(params.identity);
		case "sync":
			return await registry.sync(params.identity);
		case "restart":
			return await registry.restart(params.identity);
		case "create_invite":
			return await registry.createInvite(params.identity, params.expiresInSeconds);
		case "connect":
			return await registry.connect({
				identity: params.identity,
				inviteUrl: requireString(params.inviteUrl, "inviteUrl"),
			});
		case "send_message":
			return await registry.sendMessage({
				identity: params.identity,
				peer: requireString(params.peer, "peer"),
				text: requireString(params.text, "text"),
				scope: optionalString(params.scope),
			});
		case "publish_grants":
			return await registry.publishGrantSet({
				identity: params.identity,
				peer: requireString(params.peer, "peer"),
				grantSet: normalizeGrantInput(params.grantSet),
				note: optionalString(params.note),
			});
		case "request_grants":
			return await registry.requestGrantSet({
				identity: params.identity,
				peer: requireString(params.peer, "peer"),
				grantSet: normalizeGrantInput(params.grantSet),
				note: optionalString(params.note),
			});
		case "request_funds":
			return await registry.requestFunds({
				identity: params.identity,
				peer: requireString(params.peer, "peer"),
				asset: params.asset ?? "native",
				amount: requireString(params.amount, "amount"),
				chain: optionalString(params.chain),
				toAddress: normalizeAddress(params.toAddress),
				note: optionalString(params.note),
			});
		case "request_meeting":
			return await registry.requestMeeting({
				identity: params.identity,
				peer: requireString(params.peer, "peer"),
				title: requireString(params.title, "title"),
				duration: typeof params.duration === "number" ? params.duration : 60,
				preferred: optionalString(params.preferred),
				location: optionalString(params.location),
				note: optionalString(params.note),
			});
		case "respond_meeting":
			return await registry.respondMeeting({
				identity: params.identity,
				schedulingId: requireString(params.schedulingId, "schedulingId"),
				action: requireString(params.meetingAction, "meetingAction"),
				reason: optionalString(params.reason),
			});
		case "cancel_meeting":
			return await registry.cancelMeeting({
				identity: params.identity,
				schedulingId: requireString(params.schedulingId, "schedulingId"),
				reason: optionalString(params.reason),
			});
		case "list_pending":
			return await registry.listPending(params.identity);
		case "resolve_pending":
			return await registry.resolvePending({
				identity: params.identity,
				requestId: requireString(params.requestId, "requestId"),
				approve: requireBoolean(params.approve, "approve"),
			});
		default:
			params.action satisfies never;
			throw new Error(`Unsupported TAP Gateway action: ${String(params.action)}`);
	}
}

function json(payload: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

function requireString(value: string | undefined, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${name} is required`);
	}
	return value.trim();
}

function optionalString(value: string | undefined): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireBoolean(value: boolean | undefined, name: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${name} is required`);
	}
	return value;
}

function normalizeAddress(value: string | undefined): `0x${string}` | undefined {
	if (value === undefined || value.trim().length === 0) {
		return undefined;
	}
	if (!isEthereumAddress(value)) {
		throw new Error(`Invalid Ethereum address: ${value}`);
	}
	return value;
}
