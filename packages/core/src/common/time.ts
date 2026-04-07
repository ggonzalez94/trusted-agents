export function nowISO(): string {
	return new Date().toISOString();
}

function nowUnix(): number {
	return Math.floor(Date.now() / 1000);
}

export function isExpired(expiresUnix: number): boolean {
	return nowUnix() >= expiresUnix;
}

export function expiresIn(seconds: number): number {
	return nowUnix() + seconds;
}

export function toISO(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString();
}
