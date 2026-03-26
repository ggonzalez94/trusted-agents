import type { Argument, Command, Option } from "commander";
import { COMMAND_METADATA } from "./command-metadata.js";

export interface CommandSchema {
	arguments: Array<{
		default?: unknown;
		description?: string;
		name: string;
		required: boolean;
		variadic: boolean;
	}>;
	auth?: string[];
	description: string;
	examples?: string[];
	mutates: boolean;
	name: string;
	notes?: string[];
	options: Array<{
		default?: unknown;
		description?: string;
		flags: string;
		name: string;
		required: boolean;
		scope: "global" | "local";
		takes_value: boolean;
	}>;
	path: string;
	supports_dry_run: boolean;
	supports_fields: boolean;
	supports_stdin: boolean;
	subcommands: CommandSchema[];
}

export function findCommand(program: Command, path: string[]): Command | undefined {
	let current: Command | undefined = program;
	for (const segment of path) {
		current = current?.commands.find((command) => command.name() === segment);
		if (!current) {
			return undefined;
		}
	}
	return current;
}

export function serializeCommand(
	command: Command,
	options?: { includeInheritedOptions?: boolean },
): CommandSchema {
	const path = commandPath(command);
	const metadata = COMMAND_METADATA[path] ?? {};
	const optionSchemas = options?.includeInheritedOptions
		? serializeMergedOptions(command)
		: serializeOptions(command.options, "local");

	return {
		arguments: command.registeredArguments.map(serializeArgument),
		...(metadata.auth ? { auth: metadata.auth } : {}),
		description: command.description(),
		...(metadata.examples ? { examples: metadata.examples } : {}),
		mutates: metadata.mutates ?? false,
		name: command.name(),
		...(metadata.notes ? { notes: metadata.notes } : {}),
		options: optionSchemas,
		path,
		subcommands: command.commands
			.filter((child) => child.name() !== "help")
			.map((child) => serializeCommand(child)),
		supports_dry_run: metadata.supportsDryRun ?? false,
		supports_fields: metadata.supportsFields ?? false,
		supports_stdin: metadata.supportsStdin ?? false,
	};
}

export function commandPath(command: Command): string {
	const segments: string[] = [];
	let cursor: Command | null = command;
	while (cursor) {
		if (cursor.name()) {
			segments.unshift(cursor.name());
		}
		cursor = cursor.parent ?? null;
	}
	return segments.join(" ");
}

function serializeMergedOptions(command: Command): CommandSchema["options"] {
	const seen = new Set<string>();
	const options: CommandSchema["options"] = [];
	const lineage: Command[] = [];
	let cursor: Command | null = command;
	while (cursor) {
		lineage.unshift(cursor);
		cursor = cursor.parent ?? null;
	}

	for (const [index, current] of lineage.entries()) {
		const scope = index === lineage.length - 1 ? "local" : "global";
		for (const option of current.options) {
			const name = option.attributeName();
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			options.push(serializeOption(option, scope));
		}
	}

	return options;
}

function serializeOptions(
	options: readonly Option[],
	scope: "global" | "local",
): CommandSchema["options"] {
	return options.map((option) => serializeOption(option, scope));
}

function serializeOption(
	option: Option,
	scope: "global" | "local",
): CommandSchema["options"][number] {
	return {
		...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
		description: option.description,
		flags: option.flags,
		name: option.attributeName(),
		required: Boolean(option.mandatory),
		scope,
		takes_value: Boolean(option.required || option.optional),
	};
}

function serializeArgument(argument: Argument): CommandSchema["arguments"][number] {
	return {
		...(argument.defaultValue !== undefined ? { default: argument.defaultValue } : {}),
		...(argument.description ? { description: argument.description } : {}),
		name: argument.name(),
		required: Boolean(argument.required),
		variadic: Boolean(argument.variadic),
	};
}
