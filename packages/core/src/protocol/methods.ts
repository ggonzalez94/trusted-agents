export const CONNECTION_REQUEST = "connection/request" as const;
export const CONNECTION_RESULT = "connection/result" as const;
export const CONNECTION_REVOKE = "connection/revoke" as const;
export const PERMISSIONS_UPDATE = "permissions/update" as const;
export const MESSAGE_SEND = "message/send" as const;
export const ACTION_REQUEST = "action/request" as const;
export const ACTION_RESULT = "action/result" as const;

export const BOOTSTRAP_METHODS = new Set([CONNECTION_REQUEST, CONNECTION_RESULT]);

export const RESULT_METHODS = new Set([CONNECTION_RESULT, ACTION_RESULT]);

export type ResultMethod = typeof CONNECTION_RESULT | typeof ACTION_RESULT;

export function isResultMethod(method: string): method is ResultMethod {
	return method === CONNECTION_RESULT || method === ACTION_RESULT;
}
