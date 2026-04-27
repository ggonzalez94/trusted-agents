import { v4 as uuidv4 } from "uuid";

export function generateNonce(): string {
	return uuidv4();
}

export function generateConnectionId(): string {
	return uuidv4();
}

export function generateActionId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
