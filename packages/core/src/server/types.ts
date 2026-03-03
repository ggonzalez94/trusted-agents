import type { Contact } from "../trust/types.js";

export interface ServerConfig {
	agentId: number;
	chain: string;
	privateKey: `0x${string}`;
	agentAddress: `0x${string}`;
	dataDir: string;
	agentName: string;
	agentDescription: string;
	capabilities: string[];
	agentUrl: string;
	signatureMaxAgeSeconds?: number;
	signatureClockSkewSeconds?: number;
	rateLimitPerMinute?: number;
}

export interface RequestContext {
	verifiedAddress: `0x${string}`;
	keyId: string;
	contact: Contact | null;
}

export type ServerEnv = {
	Variables: {
		requestContext: RequestContext;
		requestBody: string;
		requestMethod?: string;
	};
};

export type MethodHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;
