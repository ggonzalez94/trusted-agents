export class TrustedAgentError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message);
		this.name = "TrustedAgentError";
	}
}

export class AuthenticationError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "AUTH_ERROR");
		this.name = "AuthenticationError";
	}
}

export class IdentityError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "IDENTITY_ERROR");
		this.name = "IdentityError";
	}
}

export class ConnectionError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "CONNECTION_ERROR");
		this.name = "ConnectionError";
	}
}

export class PermissionError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "PERMISSION_ERROR");
		this.name = "PermissionError";
	}
}

export class TransportError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "TRANSPORT_ERROR");
		this.name = "TransportError";
	}
}

export class ConfigError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR");
		this.name = "ConfigError";
	}
}
