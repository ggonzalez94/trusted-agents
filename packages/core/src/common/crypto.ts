import { v4 as uuidv4 } from "uuid";

export function generateNonce(): string {
	return uuidv4();
}

export function generateConnectionId(): string {
	return uuidv4();
}
