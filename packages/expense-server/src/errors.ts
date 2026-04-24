export class ExpenseServerError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ExpenseServerError";
	}
}

export function badRequest(message: string, code = "INVALID_REQUEST"): ExpenseServerError {
	return new ExpenseServerError(400, code, message);
}

export function unauthenticated(
	message = "Missing or invalid expense API token",
): ExpenseServerError {
	return new ExpenseServerError(401, "UNAUTHENTICATED", message);
}

export function notFound(message: string, code = "NOT_FOUND"): ExpenseServerError {
	return new ExpenseServerError(404, code, message);
}

export function conflict(message: string, code = "CONFLICT"): ExpenseServerError {
	return new ExpenseServerError(409, code, message);
}
