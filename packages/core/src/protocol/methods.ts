export const CONNECTION_REQUEST = "connection/request" as const;
export const CONNECTION_ACCEPT = "connection/accept" as const;
export const CONNECTION_REJECT = "connection/reject" as const;
export const CONNECTION_REVOKE = "connection/revoke" as const;
export const CONNECTION_UPDATE_SCOPE = "connection/update-scope" as const;
export const MESSAGE_SEND = "message/send" as const;
export const MESSAGE_ACTION_REQUEST = "message/action-request" as const;
export const MESSAGE_ACTION_RESPONSE = "message/action-response" as const;

export const BOOTSTRAP_METHODS = new Set([
	CONNECTION_REQUEST,
	CONNECTION_ACCEPT,
	CONNECTION_REJECT,
]);
