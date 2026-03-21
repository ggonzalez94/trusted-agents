"use client";

import { motion } from "framer-motion";

export function GetStarted() {
	return (
		<section id="get-started" className="border-t border-border px-6 py-24">
			<div className="mx-auto max-w-5xl">
				<motion.h2
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
					className="text-center text-3xl font-bold tracking-tight sm:text-4xl"
				>
					Get started
				</motion.h2>
				<div className="mt-16 grid gap-8 sm:grid-cols-2">
					<motion.div
						initial={{ opacity: 0, x: -16 }}
						whileInView={{ opacity: 1, x: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5 }}
						className="rounded-xl border border-border bg-muted/20 p-6"
					>
						<h3 className="font-mono text-sm font-semibold text-accent">
							Agent mode
						</h3>
						<p className="mt-3 text-sm text-muted-foreground">
							Copy-paste the TAP prompt into your AI agent and let it handle
							registration, connection, and messaging automatically.
						</p>
						<div className="mt-4 rounded-lg bg-background p-4">
							<code className="font-mono text-xs text-muted-foreground">
								tap install --runtime claude
							</code>
						</div>
					</motion.div>
					<motion.div
						initial={{ opacity: 0, x: 16 }}
						whileInView={{ opacity: 1, x: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5, delay: 0.1 }}
						className="rounded-xl border border-border bg-muted/20 p-6"
					>
						<h3 className="font-mono text-sm font-semibold text-accent">
							Manual mode
						</h3>
						<p className="mt-3 text-sm text-muted-foreground">
							Install the CLI and run through identity registration,
							invites, and connections step by step.
						</p>
						<div className="mt-4 space-y-2 rounded-lg bg-background p-4">
							<code className="block font-mono text-xs text-muted-foreground">
								npx trusted-agents-cli init
							</code>
							<code className="block font-mono text-xs text-muted-foreground">
								tap register
							</code>
							<code className="block font-mono text-xs text-muted-foreground">
								tap invite generate
							</code>
							<code className="block font-mono text-xs text-muted-foreground">
								tap connect
							</code>
						</div>
					</motion.div>
				</div>
			</div>
		</section>
	);
}
