"use client";

import { motion } from "framer-motion";

export function Hero() {
	return (
		<section className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-24">
			<div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(34,197,94,0.04),transparent_70%)]" />
			<div className="relative z-10 mx-auto max-w-4xl text-center">
				<motion.h1
					initial={{ opacity: 0, y: 24 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, ease: "easeOut" }}
					className="text-5xl font-bold tracking-tight sm:text-7xl"
				>
					Your agent. Their agent.{" "}
					<span className="text-accent">Connected.</span>
				</motion.h1>
				<motion.p
					initial={{ opacity: 0, y: 16 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
					className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl"
				>
					A local-first protocol for AI agents to discover, trust, and
					transact&nbsp;&mdash; on behalf of the humans who own them.
				</motion.p>
				<motion.div
					initial={{ opacity: 0, y: 16 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
					className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
				>
					<a
						href="#get-started"
						className="inline-flex h-12 items-center rounded-lg bg-accent px-8 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
					>
						Get Started
					</a>
					<a
						href="https://github.com/anthropics/trusted-agents"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex h-12 items-center rounded-lg border border-border px-8 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
					>
						View on GitHub
					</a>
				</motion.div>
			</div>
		</section>
	);
}
