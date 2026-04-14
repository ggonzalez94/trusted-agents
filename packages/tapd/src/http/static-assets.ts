import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Tiny static-asset resolver for the bundled UI. Resolves a URL path against
 * a root directory, refusing path traversal and unknown extensions.
 *
 * Returns `null` when the path cannot be served (missing, traversal, etc.).
 * The HTTP server treats null as "not handled" and falls through to the API
 * router, so a missing asset becomes a regular 404.
 */

export interface StaticAsset {
	body: Buffer;
	contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

export async function resolveStaticAsset(
	rootDir: string,
	urlPath: string,
): Promise<StaticAsset | null> {
	if (urlPath.includes("\u0000")) return null;

	const normalizedRoot = resolve(rootDir);
	const cleaned = normalize(urlPath === "/" ? "/index.html" : urlPath);
	const candidate = resolve(join(normalizedRoot, cleaned));

	const insideRoot =
		candidate === normalizedRoot ||
		candidate.startsWith(`${normalizedRoot}${sep}`);
	if (!insideRoot) return null;

	let target = candidate;
	try {
		const stats = await stat(target);
		if (stats.isDirectory()) {
			target = join(target, "index.html");
		}
		const body = await readFile(target);
		const contentType =
			CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
		return { body, contentType };
	} catch {
		return null;
	}
}
