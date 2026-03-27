export type OutputFormat = "json" | "text" | "ndjson";

export interface GlobalOptions {
	output?: OutputFormat;
	json?: boolean;
	plain?: boolean;
	config?: string;
	dataDir?: string;
	chain?: string;
	rpcUrl?: string;
	verbose?: boolean;
	quiet?: boolean;
	select?: string;
	fields?: string;
	limit?: string | number;
	offset?: string | number;
	describe?: boolean;
	commandPath?: string;
}
