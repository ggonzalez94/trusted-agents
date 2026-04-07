import { loadTapHermesDaemonState, type TapHermesDaemonState, getTapHermesPaths } from "./config.js";
import { type HermesTapRequest, sendHermesTapRequest } from "./ipc.js";

export async function sendHermesTapDaemonRequest(
	hermesHome: string | undefined,
	request: HermesTapRequest,
): Promise<unknown> {
	const daemonState = await loadTapHermesDaemonState(hermesHome);
	const socketPath = daemonState?.socketPath ?? getTapHermesPaths(hermesHome).socketPath;
	return await sendHermesTapRequest(socketPath, request);
}

export async function readHermesTapDaemonState(
	hermesHome: string | undefined,
): Promise<TapHermesDaemonState | null> {
	return await loadTapHermesDaemonState(hermesHome);
}
