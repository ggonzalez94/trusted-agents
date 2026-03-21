import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function commandExists(command: string): Promise<boolean> {
	const pathVar = process.env.PATH ?? "";
	for (const entry of pathVar.split(delimiter)) {
		if (!entry) {
			continue;
		}
		const candidate = join(entry, command);
		try {
			await access(candidate);
			return true;
		} catch {}
	}
	return false;
}
