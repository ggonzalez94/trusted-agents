import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Creates a fresh temp directory before each test and cleans it up after.
 * Returns an object whose `.path` property holds the current temp dir path.
 */
export function useTempDir(prefix: string): { readonly path: string } {
	const state = { path: "" };

	beforeEach(async () => {
		state.path = await mkdtemp(join(tmpdir(), `${prefix}-`));
	});

	afterEach(async () => {
		if (state.path) {
			await rm(state.path, { recursive: true, force: true });
		}
	});

	return state as { readonly path: string };
}

/**
 * Tracks multiple temp directories created during tests and cleans them all up after each test.
 * Returns an object with a `track(dir)` method and a `dirs` array.
 */
export function useTempDirs(): {
	readonly dirs: string[];
	track(dir: string): void;
} {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			dirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
		);
	});

	return {
		dirs,
		track(dir: string) {
			dirs.push(dir);
		},
	};
}
