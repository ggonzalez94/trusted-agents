import { afterEach, beforeEach } from "vitest";

export interface CapturedOutput {
	readonly stdout: string[];
	readonly stderr: string[];
}

/**
 * Captures process.stdout and process.stderr writes during each test.
 * Must be called at the top level of a describe() block.
 * Returns an object whose stdout/stderr arrays are reset before each test
 * and restored after each test.
 */
export function useCapturedOutput(): CapturedOutput {
	const captured: CapturedOutput = { stdout: [], stderr: [] };
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
		captured.stdout.length = 0;
		captured.stderr.length = 0;
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			captured.stdout.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			captured.stderr.push(chunk);
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
	});

	return captured;
}
