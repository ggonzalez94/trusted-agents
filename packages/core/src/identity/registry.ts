import type { PublicClient, WalletClient } from "viem";
import { IdentityError } from "../common/index.js";
import { ERC8004_ABI } from "./abi.js";

export interface IIdentityRegistry {
	getTokenURI(agentId: number): Promise<string>;
	getOwner(agentId: number): Promise<`0x${string}`>;
	register(agentURI: string, walletClient: WalletClient): Promise<number>;
	setAgentURI(agentId: number, newURI: string, walletClient: WalletClient): Promise<void>;
}

export class ERC8004Registry implements IIdentityRegistry {
	constructor(
		private readonly publicClient: PublicClient,
		private readonly registryAddress: `0x${string}`,
	) {}

	/** Verify the registry contract exists on-chain before sending transactions. */
	async verifyDeployed(): Promise<void> {
		const code = await this.publicClient.getCode({ address: this.registryAddress });
		if (!code || code === "0x") {
			throw new IdentityError(
				`No ERC-8004 registry contract at ${this.registryAddress} on this chain. Check that the registry address matches the network (testnet vs mainnet). See https://github.com/erc-8004/erc-8004-contracts for deployed addresses.`,
			);
		}
	}

	async getTokenURI(agentId: number): Promise<string> {
		try {
			const uri = await this.publicClient.readContract({
				address: this.registryAddress,
				abi: ERC8004_ABI,
				functionName: "tokenURI",
				args: [BigInt(agentId)],
			});
			return uri;
		} catch (error) {
			throw new IdentityError(
				`Failed to get tokenURI for agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async getOwner(agentId: number): Promise<`0x${string}`> {
		try {
			const owner = await this.publicClient.readContract({
				address: this.registryAddress,
				abi: ERC8004_ABI,
				functionName: "ownerOf",
				args: [BigInt(agentId)],
			});
			return owner;
		} catch (error) {
			throw new IdentityError(
				`Failed to get owner for agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async register(agentURI: string, walletClient: WalletClient): Promise<number> {
		try {
			if (!walletClient.account) {
				throw new IdentityError("No account available on wallet client");
			}

			const hash = await walletClient.writeContract({
				address: this.registryAddress,
				abi: ERC8004_ABI,
				functionName: "register",
				args: [agentURI],
				account: walletClient.account,
				chain: walletClient.chain,
			});

			const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

			const transferLog = (receipt.logs ?? []).find(
				(log) =>
					log.address.toLowerCase() === this.registryAddress.toLowerCase() &&
					log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
			);

			if (!transferLog || !transferLog.topics[3]) {
				throw new IdentityError(
					"Transfer event not found in transaction receipt. " +
						"The transaction may have succeeded on-chain — check the registry with `tap identity resolve-self`.",
				);
			}

			return Number(BigInt(transferLog.topics[3]));
		} catch (error) {
			if (error instanceof IdentityError) throw error;
			throw new IdentityError(
				`Failed to register agent: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async setAgentURI(agentId: number, newURI: string, walletClient: WalletClient): Promise<void> {
		try {
			if (!walletClient.account) {
				throw new IdentityError("No account available on wallet client");
			}

			const hash = await walletClient.writeContract({
				address: this.registryAddress,
				abi: ERC8004_ABI,
				functionName: "setAgentURI",
				args: [BigInt(agentId), newURI],
				account: walletClient.account,
				chain: walletClient.chain,
			});

			await this.publicClient.waitForTransactionReceipt({ hash });
		} catch (error) {
			if (error instanceof IdentityError) throw error;
			throw new IdentityError(
				`Failed to set agent URI for agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
