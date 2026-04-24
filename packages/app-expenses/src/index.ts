import { defineTapApp } from "trusted-agents-core";

export * from "./amounts.js";
export * from "./grants.js";
export * from "./types.js";

export const expenseApp = defineTapApp({
	id: "expenses",
	name: "Shared Expenses",
	version: "1.0.0",
	actions: {
		"expense/group.invite": {
			handler: async (ctx) => {
				ctx.events.emit({ type: "expense/group.invite", summary: "Expense group invite received" });
				return { success: true };
			},
		},
		"expense/group.accept": {
			handler: async (ctx) => {
				ctx.events.emit({ type: "expense/group.accept", summary: "Expense group accepted" });
				return { success: true };
			},
		},
		"expense/created": {
			handler: async (ctx) => {
				ctx.events.emit({ type: "expense/created", summary: "Expense recorded" });
				return { success: true };
			},
		},
		"expense/acknowledge": {
			handler: async (ctx) => {
				ctx.events.emit({ type: "expense/acknowledge", summary: "Expense acknowledged" });
				return { success: true };
			},
		},
		"expense/dispute": {
			handler: async (ctx) => {
				ctx.events.emit({ type: "expense/dispute", summary: "Expense disputed" });
				return { success: true };
			},
		},
		"expense/adjust": {
			handler: async (ctx) => {
				ctx.events.emit({ type: "expense/adjust", summary: "Expense adjusted" });
				return { success: true };
			},
		},
		"expense/settlement.intent": {
			handler: async (ctx) => {
				ctx.events.emit({
					type: "expense/settlement.intent",
					summary: "Expense settlement requested",
				});
				return { success: true };
			},
		},
		"expense/settlement.completed": {
			handler: async (ctx) => {
				ctx.events.emit({
					type: "expense/settlement.completed",
					summary: "Expense settlement completed",
				});
				return { success: true };
			},
		},
		"expense/settlement.failed": {
			handler: async (ctx) => {
				ctx.events.emit({
					type: "expense/settlement.failed",
					summary: "Expense settlement failed",
				});
				return { success: true };
			},
		},
	},
	grantScopes: ["expense/settle"],
});

export default expenseApp;
