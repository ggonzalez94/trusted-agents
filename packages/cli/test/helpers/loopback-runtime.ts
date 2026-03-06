import { FileConversationLogger, FileTrustStore } from "trusted-agents-core";
import type {
	IAgentResolver,
	ProtocolMessage,
	ProtocolResponse,
	ResolvedAgent,
	TransportProvider,
} from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { clearCliRuntimeOverride, setCliRuntimeOverride } from "../../src/lib/runtime-overrides.js";

export interface TestAgentFixture {
	agentId: number;
	chain: string;
	privateKey: `0x${string}`;
	name: string;
	description: string;
	capabilities: string[];
}

export function createResolvedAgentFixture(fixture: TestAgentFixture): ResolvedAgent {
	const address = privateKeyToAccount(fixture.privateKey).address;
	return {
		agentId: fixture.agentId,
		chain: fixture.chain,
		ownerAddress: address,
		agentAddress: address,
		xmtpEndpoint: address,
		endpoint: undefined,
		capabilities: fixture.capabilities,
		registrationFile: {
			type: "eip-8004-registration-v1",
			name: fixture.name,
			description: fixture.description,
			services: [{ name: "xmtp", endpoint: address }],
			trustedAgentProtocol: {
				version: "1.0",
				agentAddress: address,
				capabilities: fixture.capabilities,
			},
		},
		resolvedAt: "2026-03-06T00:00:00.000Z",
	};
}

export class StaticAgentResolver implements IAgentResolver {
	private readonly byKey = new Map<string, ResolvedAgent>();

	constructor(agents: ResolvedAgent[]) {
		for (const agent of agents) {
			this.byKey.set(this.key(agent.agentId, agent.chain), agent);
		}
	}

	async resolve(agentId: number, chain: string): Promise<ResolvedAgent> {
		const agent = this.byKey.get(this.key(agentId, chain));
		if (!agent) {
			throw new Error(`Agent not found in static resolver: ${agentId} on ${chain}`);
		}
		return agent;
	}

	async resolveWithCache(agentId: number, chain: string): Promise<ResolvedAgent> {
		return await this.resolve(agentId, chain);
	}

	private key(agentId: number, chain: string): string {
		return `${agentId}:${chain}`;
	}
}

export class LoopbackTransportNetwork {
	private readonly stacks = new Map<number, LoopbackTransport[]>();

	register(agentId: number, transport: LoopbackTransport): void {
		const stack = this.stacks.get(agentId) ?? [];
		stack.push(transport);
		this.stacks.set(agentId, stack);
	}

	unregister(agentId: number, transport: LoopbackTransport): void {
		const stack = this.stacks.get(agentId);
		if (!stack) {
			return;
		}

		const index = stack.lastIndexOf(transport);
		if (index >= 0) {
			stack.splice(index, 1);
		}

		if (stack.length === 0) {
			this.stacks.delete(agentId);
			return;
		}

		this.stacks.set(agentId, stack);
	}

	getActive(agentId: number): LoopbackTransport | undefined {
		const stack = this.stacks.get(agentId);
		return stack?.[stack.length - 1];
	}
}

export class LoopbackTransport implements TransportProvider {
	private handler:
		| ((from: number, message: ProtocolMessage) => Promise<ProtocolResponse>)
		| undefined;
	private started = false;

	constructor(
		private readonly network: LoopbackTransportNetwork,
		private readonly localAgentId: number,
	) {}

	async send(peerId: number, message: ProtocolMessage): Promise<ProtocolResponse> {
		const peer = this.network.getActive(peerId);
		if (!peer?.handler) {
			throw new Error(`Peer ${peerId} is not reachable on the loopback network`);
		}

		const response = await peer.handler(
			this.localAgentId,
			structuredClone(message) as ProtocolMessage,
		);
		return structuredClone(response) as ProtocolResponse;
	}

	onMessage(callback: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>): void {
		this.handler = callback;
	}

	async isReachable(peerId: number): Promise<boolean> {
		return this.network.getActive(peerId) !== undefined;
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.network.register(this.localAgentId, this);
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}
		this.network.unregister(this.localAgentId, this);
		this.started = false;
	}
}

export function installLoopbackRuntime(params: {
	dataDir: string;
	network: LoopbackTransportNetwork;
	resolver: StaticAgentResolver;
	txHashPrefix: string;
}): void {
	setCliRuntimeOverride(params.dataDir, {
		createContext: () => ({
			trustStore: new FileTrustStore(params.dataDir),
			resolver: params.resolver,
			conversationLogger: new FileConversationLogger(params.dataDir),
		}),
		createTransport: (config) => new LoopbackTransport(params.network, config.agentId),
		executeTransferAction: async () => ({
			txHash: formatTxHash(params.txHashPrefix),
		}),
	});
}

export function clearLoopbackRuntime(dataDir: string): void {
	clearCliRuntimeOverride(dataDir);
}

function formatTxHash(seed: string): `0x${string}` {
	const hex = seed.replace(/^0x/, "").toLowerCase();
	return `0x${hex.padEnd(64, "0").slice(0, 64)}` as `0x${string}`;
}
