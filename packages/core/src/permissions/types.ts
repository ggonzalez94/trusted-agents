export interface PermissionCheck {
	connectionId: string;
	scope: string;
	action?: string;
}

export interface PermissionResult {
	allowed: boolean;
	reason?: string;
}
