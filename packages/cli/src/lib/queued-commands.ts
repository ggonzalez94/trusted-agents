import { setTimeout as sleep } from "node:timers/promises";
import {
	AuthenticationError,
	ConfigError,
	ConnectionError,
	FileTapCommandOutbox,
	IdentityError,
	PermissionError,
	type TapCommandJob,
	type TapCommandJobResult,
	type TapCommandJobResultPayload,
	TransportError,
	type TransportOwnerInfo,
	TransportOwnershipError,
	TrustedAgentError,
	ValidationError,
} from "trusted-agents-core";

const QUEUED_COMMAND_WAIT_MS = 2_000;
const QUEUED_COMMAND_POLL_INTERVAL_MS = 250;

export type QueuedTapCommandOutcome<T> =
	| {
			status: "executed";
			result: T;
			queued: false;
	  }
	| {
			status: "completed";
			result: T;
			queued: true;
			jobId: string;
			owner?: TransportOwnerInfo;
	  }
	| {
			status: "queued";
			jobId: string;
			owner?: TransportOwnerInfo;
	  };

export type PendingQueuedTapCommandOutcome = Extract<
	QueuedTapCommandOutcome<unknown>,
	{ status: "queued" }
>;

export type SettledQueuedTapCommandOutcome<T> = Exclude<
	QueuedTapCommandOutcome<T>,
	{ status: "queued" }
>;

export async function runOrQueueTapCommand<T extends TapCommandJobResultPayload>(
	dataDir: string,
	job: Omit<TapCommandJob, "jobId" | "createdAt">,
	run: () => Promise<T>,
	options: {
		requestedBy?: string;
	} = {},
): Promise<QueuedTapCommandOutcome<T>> {
	try {
		return {
			status: "executed",
			result: await run(),
			queued: false,
		};
	} catch (error: unknown) {
		if (!(error instanceof TransportOwnershipError)) {
			throw error;
		}

		const outbox = new FileTapCommandOutbox(dataDir);
		const queued = await outbox.enqueue({
			...job,
			requestedBy: options.requestedBy,
		});
		const deadline = Date.now() + QUEUED_COMMAND_WAIT_MS;
		while (Date.now() < deadline) {
			const result = await outbox.getResult(queued.jobId);
			if (!result) {
				await sleep(QUEUED_COMMAND_POLL_INTERVAL_MS);
				continue;
			}
			if (result.status === "failed") {
				throw hydrateQueuedCommandError(result, queued.jobId);
			}
			return {
				status: "completed",
				result: result.result as T,
				queued: true,
				jobId: queued.jobId,
				owner: error.currentOwner,
			};
		}

		return {
			status: "queued",
			jobId: queued.jobId,
			owner: error.currentOwner,
		};
	}
}

export function isQueuedTapCommandPending<T>(
	outcome: QueuedTapCommandOutcome<T>,
): outcome is PendingQueuedTapCommandOutcome {
	return outcome.status === "queued";
}

export function queuedTapCommandPendingFields(outcome: PendingQueuedTapCommandOutcome): {
	queued: true;
	job_id: string;
	owner?: TransportOwnerInfo;
} {
	return {
		queued: true,
		job_id: outcome.jobId,
		owner: outcome.owner,
	};
}

export function queuedTapCommandResultFields<T>(outcome: SettledQueuedTapCommandOutcome<T>): {
	queued: boolean;
	job_id?: string;
} {
	return {
		queued: outcome.queued,
		job_id: outcome.status === "completed" ? outcome.jobId : undefined,
	};
}

function hydrateQueuedCommandError(result: TapCommandJobResult, jobId: string): Error {
	const message = result.error ?? `Queued TAP command ${jobId} failed`;
	switch (result.errorCode) {
		case "AUTH_ERROR":
			return new AuthenticationError(message);
		case "IDENTITY_ERROR":
			return new IdentityError(message);
		case "CONNECTION_ERROR":
			return new ConnectionError(message);
		case "PERMISSION_ERROR":
			return new PermissionError(message);
		case "TRANSPORT_ERROR":
			return new TransportError(message);
		case "CONFIG_ERROR":
			return new ConfigError(message);
		case "VALIDATION_ERROR":
			return new ValidationError(message);
		default:
			return new TrustedAgentError(message, result.errorCode);
	}
}
