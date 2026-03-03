import type { PublicClient } from "viem";

export interface MockChainOptions {
	tokenURI?: string;
	ownerAddress?: `0x${string}`;
}

export function createMockPublicClient(options: MockChainOptions = {}): PublicClient {
	const {
		tokenURI = "https://example.com/agent/1/registration.json",
		ownerAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
	} = options;

	return {
		readContract: async ({ functionName }: { functionName: string }) => {
			if (functionName === "tokenURI") {
				return tokenURI;
			}
			if (functionName === "ownerOf") {
				return ownerAddress;
			}
			throw new Error(`Unmocked function: ${functionName}`);
		},
	} as unknown as PublicClient;
}
