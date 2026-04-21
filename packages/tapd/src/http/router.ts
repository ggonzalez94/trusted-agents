import { HttpError } from "./errors.js";

export type RouteHandler<TBody = unknown, TResult = unknown> = (
	params: Record<string, string>,
	body: TBody,
) => Promise<TResult>;

interface CompiledRoute {
	method: string;
	regex: RegExp;
	paramNames: string[];
	handler: RouteHandler;
}

export class Router {
	private readonly routes: CompiledRoute[] = [];

	add(method: string, pattern: string, handler: RouteHandler): void {
		const { regex, paramNames } = compilePattern(pattern);
		this.routes.push({ method, regex, paramNames, handler });
	}

	async dispatch(method: string, path: string, body?: unknown): Promise<unknown | null> {
		const normalized = stripTrailingSlash(path);
		for (const route of this.routes) {
			if (route.method !== method) continue;
			const match = route.regex.exec(normalized);
			if (!match) continue;
			const params: Record<string, string> = {};
			// Malformed percent-encoding in a path segment (e.g. `%E0%A4%A`)
			// causes decodeURIComponent to throw URIError. Without this guard
			// that bubbles to the server's catch-all and the client sees a
			// 500 internal_error for what is really a client input mistake.
			for (let i = 0; i < route.paramNames.length; i++) {
				const name = route.paramNames[i];
				if (name === undefined) continue;
				const raw = match[i + 1] ?? "";
				try {
					params[name] = decodeURIComponent(raw);
				} catch {
					throw new HttpError(
						400,
						"malformed_param",
						`route parameter ${name} has malformed percent-encoding`,
					);
				}
			}
			return await route.handler(params, body);
		}
		return null;
	}
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	const regexStr = pattern
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":")) {
				paramNames.push(segment.slice(1));
				return "([^/]+)";
			}
			return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

function stripTrailingSlash(path: string): string {
	if (path.length > 1 && path.endsWith("/")) {
		return path.slice(0, -1);
	}
	return path;
}
