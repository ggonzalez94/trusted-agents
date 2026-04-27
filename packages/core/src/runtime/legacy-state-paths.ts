import { join } from "node:path";

export const LEGACY_PENDING_CONNECTS_FILE = "pending-connects.json";
export const LEGACY_OUTBOX_DIR = "outbox";
export const LEGACY_OUTBOX_QUEUED_DIR = "queued";
export const LEGACY_OUTBOX_PROCESSING_DIR = "processing";
export const LEGACY_OUTBOX_RESULTS_DIR = "results";

export function legacyPendingConnectsPath(dataDir: string): string {
	return join(dataDir, LEGACY_PENDING_CONNECTS_FILE);
}

export function legacyOutboxDir(dataDir: string): string {
	return join(dataDir, LEGACY_OUTBOX_DIR);
}

export function legacyOutboxQueuedDir(dataDir: string): string {
	return join(legacyOutboxDir(dataDir), LEGACY_OUTBOX_QUEUED_DIR);
}

export function legacyOutboxProcessingDir(dataDir: string): string {
	return join(legacyOutboxDir(dataDir), LEGACY_OUTBOX_PROCESSING_DIR);
}

export function legacyOutboxResultsDir(dataDir: string): string {
	return join(legacyOutboxDir(dataDir), LEGACY_OUTBOX_RESULTS_DIR);
}
