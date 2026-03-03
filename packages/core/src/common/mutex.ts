export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const current = this.tail;
		let release: (() => void) | undefined;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		await current;
		try {
			return await fn();
		} finally {
			release?.();
		}
	}
}
