import type { ExpenseParticipant, ExpenseSplitShare } from "./types.js";

const USDC_DECIMALS = 6;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

export function parseUsdcAmount(input: string): bigint {
	const trimmed = input.trim();
	if (/^-/.test(trimmed)) {
		throw new Error("USDC amount must be positive");
	}

	if (!/^\d+(\.\d+)?$/.test(trimmed)) {
		throw new Error(`Invalid USDC amount: ${input}`);
	}

	const [wholeRaw, fractionRaw = ""] = trimmed.split(".");
	if (fractionRaw.length > USDC_DECIMALS) {
		throw new Error("USDC amount must have at most 6 decimal places");
	}

	const whole = BigInt(wholeRaw ?? "0");
	const fraction = BigInt(fractionRaw.padEnd(USDC_DECIMALS, "0"));
	const minor = whole * USDC_SCALE + fraction;
	if (minor <= 0n) {
		throw new Error("USDC amount must be positive");
	}
	return minor;
}

export function formatUsdcMinor(minor: bigint | string): string {
	const value = typeof minor === "bigint" ? minor : BigInt(minor);
	const whole = value / USDC_SCALE;
	const fraction = value % USDC_SCALE;
	if (fraction === 0n) {
		return whole.toString();
	}
	return `${whole}.${fraction.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "")}`;
}

export function buildEqualSplits(
	amountMinor: bigint,
	participants: ExpenseParticipant[],
): ExpenseSplitShare[] {
	if (participants.length === 0) {
		throw new Error("At least one participant is required");
	}

	const share = amountMinor / BigInt(participants.length);
	let remainder = amountMinor % BigInt(participants.length);
	return participants.map((participant) => {
		const extra = remainder > 0n ? 1n : 0n;
		remainder -= extra;
		return {
			agentId: participant.agentId,
			chain: participant.chain,
			amountMinor: (share + extra).toString(),
		};
	});
}

export function deriveExpenseGroupId(participants: ExpenseParticipant[]): string {
	if (participants.length < 2) {
		throw new Error("At least two participants are required");
	}

	const normalized = participants
		.map((participant) => `${participant.chain}:${participant.agentId}`)
		.sort()
		.map((value) => value.replace(/[^a-zA-Z0-9]+/g, "_"));

	return `expgrp_${normalized.join("_")}`;
}
