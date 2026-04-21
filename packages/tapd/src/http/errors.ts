/**
 * Error type that carries an HTTP status so the server's top-level catch
 * can map client-caused failures (malformed JSON, payload too large, etc.)
 * to 4xx responses instead of the catch-all 500. Route handlers and body
 * parsers throw this when the input is at fault.
 */
export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}
