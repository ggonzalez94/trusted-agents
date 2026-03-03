export interface RegistrationFileService {
	name: string;
	endpoint: string;
}

export interface RegistrationFileTrustedAgentProtocol {
	version: string;
	agentAddress: `0x${string}`;
	capabilities: string[];
}

export interface RegistrationFile {
	type: "eip-8004-registration-v1";
	name: string;
	description: string;
	services: RegistrationFileService[];
	trustedAgentProtocol: RegistrationFileTrustedAgentProtocol;
}

export interface ResolvedAgent {
	agentId: number;
	chain: string;
	ownerAddress: `0x${string}`;
	agentAddress: `0x${string}`;
	endpoint: string;
	capabilities: string[];
	registrationFile: RegistrationFile;
	resolvedAt: string;
}
