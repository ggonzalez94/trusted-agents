export function promptYesNo(prompt: string): Promise<boolean> {
	return new Promise((resolve) => {
		process.stderr.write(prompt);
		if (!process.stdin.isTTY) {
			resolve(false);
			return;
		}
		process.stdin.setEncoding("utf-8");
		process.stdin.once("data", (data) => {
			const answer = String(data).trim().toLowerCase();
			resolve(answer === "y" || answer === "yes");
		});
	});
}

export function promptInput(prompt: string): Promise<string | null> {
	return new Promise((resolve) => {
		process.stderr.write(prompt);
		if (!process.stdin.isTTY) {
			resolve(null);
			return;
		}
		process.stdin.setEncoding("utf-8");
		process.stdin.once("data", (data) => {
			resolve(String(data).trim());
		});
	});
}
