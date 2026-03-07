import {
	type Contact,
	type PermissionGrantSet,
	type TransportReceipt,
	buildPermissionsUpdate,
	generateNonce,
	nowISO,
} from "trusted-agents-core";
import type { TrustedAgentsConfig } from "trusted-agents-core";
import { type PermissionGrantRequestAction, buildPermissionGrantRequestText } from "./actions.js";
import type { CliContextWithTransport } from "./context.js";
import { replaceGrantedByMe, replaceGrantedByPeer } from "./grants.js";
import { appendConversationLog, buildOutgoingActionRequest } from "./message-conversations.js";
import { appendPermissionLedgerEntry } from "./permission-ledger.js";

export async function publishGrantSet(params: {
	config: TrustedAgentsConfig;
	ctx: CliContextWithTransport;
	contact: Contact;
	grantSet: PermissionGrantSet;
	note?: string;
}): Promise<TransportReceipt> {
	const { config, ctx, contact, grantSet, note } = params;
	const updatedPermissions = replaceGrantedByMe(contact.permissions, grantSet);
	await ctx.trustStore.updateContact(contact.connectionId, { permissions: updatedPermissions });

	const request = buildPermissionsUpdate({
		grantSet,
		grantor: { agentId: config.agentId, chain: config.chain },
		grantee: { agentId: contact.peerAgentId, chain: contact.peerChain },
		note,
		timestamp: nowISO(),
	});

	const response = await ctx.transport.send(contact.peerAgentId, request, {
		peerAddress: contact.peerAgentAddress,
	});

	await appendPermissionLedgerEntry(config.dataDir, {
		peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
		direction: "granted-by-me",
		event: "grant-published",
		note,
	});

	return response;
}

export async function sendGrantRequest(params: {
	config: TrustedAgentsConfig;
	ctx: CliContextWithTransport;
	contact: Contact;
	grantSet: PermissionGrantSet;
	note?: string;
}): Promise<{ response: TransportReceipt; actionId: string }> {
	const { config, ctx, contact, grantSet, note } = params;
	const action: PermissionGrantRequestAction = {
		type: "permissions/request-grants",
		actionId: generateNonce(),
		grants: grantSet.grants,
		note,
	};

	const request = buildOutgoingActionRequest(
		contact,
		buildPermissionGrantRequestText(action),
		action,
		"permissions/request-grants",
	);

	const timestamp = nowISO();
	const response = await ctx.transport.send(contact.peerAgentId, request, {
		peerAddress: contact.peerAgentAddress,
	});
	await appendConversationLog(ctx.conversationLogger, contact, request, "outgoing", timestamp);
	await ctx.trustStore.touchContact(contact.connectionId);

	await appendPermissionLedgerEntry(config.dataDir, {
		peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
		direction: "local",
		event: "grant-request-sent",
		action_id: action.actionId,
		note,
	});

	return { response, actionId: action.actionId };
}

export async function storePeerGrantSet(params: {
	config: TrustedAgentsConfig;
	ctx: CliContextWithTransport;
	contact: Contact;
	grantSet: PermissionGrantSet;
	note?: string;
}): Promise<void> {
	const { config, ctx, contact, grantSet, note } = params;
	await ctx.trustStore.updateContact(contact.connectionId, {
		permissions: replaceGrantedByPeer(contact.permissions, grantSet),
	});

	await appendPermissionLedgerEntry(config.dataDir, {
		peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
		direction: "granted-by-peer",
		event: "grant-received",
		note,
	});
}
