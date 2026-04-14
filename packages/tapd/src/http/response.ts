import type { ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

export function sendError(
	res: ServerResponse,
	status: number,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): void {
	sendJson(res, status, {
		error: {
			code,
			message,
			...(details ? { details } : {}),
		},
	});
}

export function sendNotFound(res: ServerResponse): void {
	sendError(res, 404, "not_found", "no route matches this request");
}

export function sendUnauthorized(res: ServerResponse): void {
	sendError(res, 401, "unauthorized", "missing or invalid bearer token");
}
