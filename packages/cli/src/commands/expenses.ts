import { randomUUID } from "node:crypto";
import {
	type ExpenseParticipant,
	deriveExpenseGroupId,
	formatUsdcMinor,
} from "@trustedagents/app-expenses";
import {
	type Contact,
	FileTrustStore,
	type TrustedAgentsConfig,
	findContactForPeer,
} from "trusted-agents-core";
import { loadConfig, resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { ExpensesClient } from "../lib/expenses-client.js";
import {
	normalizeExpenseApiToken,
	normalizeExpenseSettlementAddress,
	normalizeExpensesServerUrl,
	readExpensesConfig,
	writeExpensesConfig,
} from "../lib/expenses-config.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

interface ExpensesSetupOptions {
	server: string;
	settlementAddress?: string;
	apiToken?: string;
}

interface ExpensesGroupCreateOptions {
	settleThreshold?: string;
}

interface ExpensesLogOptions {
	category?: string;
	idempotencyKey?: string;
}

interface ExpensesSettleOptions {
	idempotencyKey?: string;
	reason?: string;
}

export async function expensesSetupCommand(
	cmdOpts: ExpensesSetupOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const settlementAddress = cmdOpts.settlementAddress
			? normalizeExpenseSettlementAddress(cmdOpts.settlementAddress)
			: undefined;
		const apiToken = cmdOpts.apiToken ? normalizeExpenseApiToken(cmdOpts.apiToken) : undefined;
		const serverUrl = normalizeExpensesServerUrl(cmdOpts.server);
		const result = await writeExpensesConfig(opts, {
			serverUrl,
			...(settlementAddress ? { settlementAddress } : {}),
			...(apiToken ? { apiToken } : {}),
		});
		success(
			{
				server_url: serverUrl,
				...(settlementAddress ? { settlement_address: settlementAddress } : {}),
				...(apiToken ? { api_token: "***redacted***" } : {}),
				path: result.path,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function expensesGroupCreateCommand(
	peer: string,
	cmdOpts: ExpensesGroupCreateOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const context = await buildExpenseCommandContext(peer, opts);
		const group = await context.client.createGroup({
			members: context.members,
			chain: context.config.chain,
			...(cmdOpts.settleThreshold ? { settlementThreshold: cmdOpts.settleThreshold } : {}),
		});
		success(formatGroup(group), opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function expensesLogCommand(
	peer: string,
	amount: string,
	description: string,
	cmdOpts: ExpensesLogOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const context = await buildExpenseCommandContext(peer, opts);
		const groupId = deriveExpenseGroupId(context.members);
		const expense = await context.client.logExpense({
			groupId,
			idempotencyKey: cmdOpts.idempotencyKey ?? `expense-${randomUUID()}`,
			creator: context.self,
			paidBy: context.self,
			amount,
			description,
			...(cmdOpts.category ? { category: cmdOpts.category } : {}),
			participants: context.members,
		});
		success(formatExpense(expense), opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function expensesBalanceCommand(peer: string, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();
	try {
		const context = await buildExpenseCommandContext(peer, opts);
		const balance = await context.client.getBalance(deriveExpenseGroupId(context.members));
		success(formatBalance(balance), opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function expensesHistoryCommand(peer: string, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();
	try {
		const context = await buildExpenseCommandContext(peer, opts);
		const history = await context.client.getHistory(deriveExpenseGroupId(context.members));
		const expenses = Array.isArray(history.expenses) ? history.expenses : [];
		success(
			{
				group_id: String(history.groupId ?? deriveExpenseGroupId(context.members)),
				expenses: expenses.map((expense) => formatExpense(expense as Record<string, unknown>)),
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function expensesSettleCommand(
	peer: string,
	cmdOpts: ExpensesSettleOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const context = await buildExpenseCommandContext(peer, opts);
		const settlement = await context.client.createSettlement(
			deriveExpenseGroupId(context.members),
			{
				reason: cmdOpts.reason ?? "manual",
				idempotencyKey: cmdOpts.idempotencyKey ?? `settle-${randomUUID()}`,
			},
		);
		success(formatSettlement(settlement), opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

async function buildExpenseCommandContext(
	peer: string,
	opts: GlobalOptions,
): Promise<{
	client: ExpensesClient;
	config: TrustedAgentsConfig;
	self: ExpenseParticipant;
	members: ExpenseParticipant[];
}> {
	const config = await loadConfig(opts);
	const expensesConfig = await readExpensesConfig(opts);
	const contact = await resolvePeerContact(peer, resolveDataDir(opts));
	const self: ExpenseParticipant = {
		agentId: config.agentId,
		chain: config.chain,
		displayName: "Self",
		...(expensesConfig.settlementAddress ? { address: expensesConfig.settlementAddress } : {}),
	};
	const peerParticipant = contactToParticipant(contact);
	return {
		client: new ExpensesClient(expensesConfig.serverUrl, {
			...(expensesConfig.apiToken ? { apiToken: expensesConfig.apiToken } : {}),
		}),
		config,
		self,
		members: [self, peerParticipant],
	};
}

async function resolvePeerContact(peer: string, dataDir: string): Promise<Contact> {
	const store = new FileTrustStore(dataDir);
	const contact = findContactForPeer(await store.getContacts(), peer);
	if (!contact || contact.status !== "active") {
		throw new Error(`No active TAP contact found for ${peer}`);
	}
	return contact;
}

function contactToParticipant(contact: Contact): ExpenseParticipant {
	return {
		agentId: contact.peerAgentId,
		chain: contact.peerChain,
		displayName: contact.peerDisplayName,
		address: contact.peerAgentAddress,
	};
}

function formatGroup(group: Record<string, unknown>): Record<string, unknown> {
	return {
		group_id: String(group.groupId),
		chain: String(group.chain),
		asset: String(group.asset),
		members: Array.isArray(group.members)
			? group.members.map((member) => formatParticipant(member as Record<string, unknown>))
			: [],
	};
}

function formatParticipant(participant: Record<string, unknown>): Record<string, unknown> {
	return {
		agent_id: Number(participant.agentId),
		chain: String(participant.chain),
		...(typeof participant.displayName === "string" ? { name: participant.displayName } : {}),
		...(typeof participant.address === "string" ? { address: participant.address } : {}),
	};
}

function formatExpense(expense: Record<string, unknown>): Record<string, unknown> {
	return {
		event_id: String(expense.eventId),
		group_id: String(expense.groupId),
		amount: formatUsdcMinor(String(expense.amountMinor)),
		description: String(expense.description),
		...(typeof expense.category === "string" ? { category: expense.category } : {}),
		paid_by_agent_id: agentIdFrom(expense.paidBy),
		created_at: String(expense.createdAt),
	};
}

function formatBalance(balance: Record<string, unknown>): Record<string, unknown> {
	const shares = Array.isArray(balance.shares) ? balance.shares : [];
	return {
		group_id: String(balance.groupId),
		asset: String(balance.asset),
		shares: shares.map((share) => {
			const data = share as Record<string, unknown>;
			return {
				agent_id: Number(data.agentId),
				chain: String(data.chain),
				net_amount: formatSignedUsdc(String(data.netMinor)),
			};
		}),
	};
}

function formatSettlement(settlement: Record<string, unknown>): Record<string, unknown> {
	return {
		intent_id: String(settlement.intentId),
		group_id: String(settlement.groupId),
		debtor_agent_id: agentIdFrom(settlement.debtor),
		creditor_agent_id: agentIdFrom(settlement.creditor),
		amount: formatUsdcMinor(String(settlement.amountMinor)),
		chain: String(settlement.chain),
		status: String(settlement.status),
		...(typeof settlement.fromAddress === "string" ? { from_address: settlement.fromAddress } : {}),
		...(typeof settlement.toAddress === "string" ? { to_address: settlement.toAddress } : {}),
	};
}

function agentIdFrom(value: unknown): number {
	if (typeof value === "object" && value !== null) {
		return Number((value as { agentId?: unknown }).agentId);
	}
	return Number.NaN;
}

function formatSignedUsdc(value: string): string {
	const minor = BigInt(value);
	if (minor < 0n) {
		return `-${formatUsdcMinor((-minor).toString())}`;
	}
	return formatUsdcMinor(minor.toString());
}
