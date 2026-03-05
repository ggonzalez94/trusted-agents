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
