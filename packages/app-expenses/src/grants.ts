import type { PermissionGrant, PermissionGrantSet } from "trusted-agents-core";
import { parseUsdcAmount } from "./amounts.js";
import {
	EXPENSE_SETTLE_SCOPE,
	type ExpenseSettlementGrantRequest,
	type ExpenseSettlementSchedule,
} from "./types.js";

export function findApplicableExpenseSettlementGrants(
	grantSet: PermissionGrantSet,
	request: ExpenseSettlementGrantRequest,
): PermissionGrant[] {
	return grantSet.grants.filter(
		(grant) =>
			grant.status === "active" &&
			grant.scope === EXPENSE_SETTLE_SCOPE &&
			matchesExpenseSettlementGrant(grant, request),
	);
}

export function matchesExpenseSettlementGrant(
	grant: PermissionGrant,
	request: ExpenseSettlementGrantRequest,
): boolean {
	const constraints = grant.constraints;
	if (!constraints) {
		return true;
	}

	if (typeof constraints.asset === "string" && constraints.asset !== request.asset) {
		return false;
	}

	if (Array.isArray(constraints.chains)) {
		const chains = constraints.chains.filter((chain): chain is string => typeof chain === "string");
		if (chains.length > 0 && !chains.includes(request.chain)) {
			return false;
		}
	}

	if (typeof constraints.maxAmount === "string") {
		try {
			if (parseUsdcAmount(request.amount) > parseUsdcAmount(constraints.maxAmount)) {
				return false;
			}
		} catch {
			return false;
		}
	}

	if (request.reason === "threshold" && typeof constraints.threshold === "string") {
		try {
			if (parseUsdcAmount(request.amount) < parseUsdcAmount(constraints.threshold)) {
				return false;
			}
		} catch {
			return false;
		}
	}

	if (typeof constraints.schedule === "string") {
		if (!matchesScheduleConstraint(constraints.schedule, request.reason, request.schedule)) {
			return false;
		}
	}

	return true;
}

function matchesScheduleConstraint(
	constraint: string,
	reason: ExpenseSettlementGrantRequest["reason"],
	schedule: ExpenseSettlementSchedule | undefined,
): boolean {
	if (constraint === "manual") {
		return reason === "manual";
	}
	if (reason !== "schedule") {
		return true;
	}
	return schedule === constraint;
}
