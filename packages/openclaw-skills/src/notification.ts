export interface NotificationAdapter {
	notify(message: string, options?: { actions?: string[] }): Promise<string | null>;
	confirm(message: string): Promise<boolean>;
}

export class ConsoleNotificationAdapter implements NotificationAdapter {
	async notify(message: string, options?: { actions?: string[] }): Promise<string | null> {
		console.log(message);
		if (options?.actions?.length) {
			console.log(`Available actions: ${options.actions.join(", ")}`);
		}
		return null;
	}

	async confirm(message: string): Promise<boolean> {
		console.log(`[CONFIRM] ${message}`);
		return true;
	}
}
