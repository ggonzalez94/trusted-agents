export class ExpensesClientError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly code = "EXPENSE_SERVER_ERROR",
	) {
		super(message);
		this.name = "ExpensesClientError";
	}
}

export class ExpensesClient {
	constructor(
		private readonly baseUrl: string,
		private readonly options: { apiToken?: string } = {},
	) {}

	createGroup(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.post("/v1/groups", body);
	}

	logExpense(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.post("/v1/expenses", body);
	}

	getBalance(groupId: string): Promise<Record<string, unknown>> {
		return this.get(`/v1/groups/${encodeURIComponent(groupId)}/balance`);
	}

	getHistory(groupId: string): Promise<Record<string, unknown>> {
		return this.get(`/v1/groups/${encodeURIComponent(groupId)}/history`);
	}

	createSettlement(
		groupId: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.post(`/v1/groups/${encodeURIComponent(groupId)}/settlements`, body);
	}

	private async get(path: string): Promise<Record<string, unknown>> {
		return this.request("GET", path);
	}

	private async post(
		path: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.request("POST", path, body);
	}

	private async request(
		method: "GET" | "POST",
		path: string,
		body?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
			method,
			headers: {
				...(this.options.apiToken ? { authorization: `Bearer ${this.options.apiToken}` } : {}),
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body
				? {
						body: JSON.stringify(body),
					}
				: {}),
		});
		const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			const error = data.error as { code?: unknown; message?: unknown } | undefined;
			throw new ExpensesClientError(
				response.status,
				typeof error?.message === "string"
					? error.message
					: `Expense server returned ${response.status}`,
				typeof error?.code === "string" ? error.code : "EXPENSE_SERVER_ERROR",
			);
		}
		return data;
	}
}
