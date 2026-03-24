export const ERC20_NAME_ABI = [
	{
		type: "function",
		name: "name",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
] as const;

export const ERC20_VERSION_ABI = [
	{
		type: "function",
		name: "version",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
] as const;

export const ERC20_NONCES_ABI = [
	{
		type: "function",
		name: "nonces",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

export const ENTRY_POINT_NONCE_ABI = [
	{
		type: "function",
		name: "getNonce",
		stateMutability: "view",
		inputs: [
			{ name: "sender", type: "address" },
			{ name: "key", type: "uint192" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

export const SERVO_ACCOUNT_FACTORY_ABI = [
	{
		type: "function",
		name: "createAccount",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "salt", type: "uint256" },
		],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "getAddress",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "salt", type: "uint256" },
		],
		outputs: [{ name: "", type: "address" }],
	},
] as const;

export const SERVO_ACCOUNT_ABI = [
	{
		type: "function",
		name: "execute",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "target", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "data", type: "bytes" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "executeBatch",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "targets", type: "address[]" },
			{ name: "values", type: "uint256[]" },
			{ name: "calldatas", type: "bytes[]" },
		],
		outputs: [],
	},
] as const;
