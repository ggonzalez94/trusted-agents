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
			route.paramNames.forEach((name, i) => {
				params[name] = decodeURIComponent(match[i + 1] ?? "");
			});
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
