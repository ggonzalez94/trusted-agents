export function Footer() {
	return (
		<footer className="border-t border-border px-6 py-12">
			<div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
				<span className="font-mono text-sm text-muted-foreground">
					TAP &mdash; Trusted Agent Protocol
				</span>
				<div className="flex gap-6">
					<a
						href="https://github.com/anthropics/trusted-agents"
						target="_blank"
						rel="noopener noreferrer"
						className="text-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						GitHub
					</a>
					<span className="text-sm text-muted-foreground">MIT License</span>
				</div>
			</div>
		</footer>
	);
}
