export const ERC8004_ABI = [
	{
		type: "function",
		name: "tokenURI",
		stateMutability: "view",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ name: "", type: "string" }],
	},
	{
		type: "function",
		name: "ownerOf",
		stateMutability: "view",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "register",
		stateMutability: "nonpayable",
		inputs: [{ name: "agentURI", type: "string" }],
		outputs: [{ name: "tokenId", type: "uint256" }],
	},
	{
		type: "function",
		name: "setAgentURI",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "tokenId", type: "uint256" },
			{ name: "newURI", type: "string" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "event",
		name: "Transfer",
		inputs: [
			{ name: "from", type: "address", indexed: true },
			{ name: "to", type: "address", indexed: true },
			{ name: "tokenId", type: "uint256", indexed: true },
		],
	},
] as const;
