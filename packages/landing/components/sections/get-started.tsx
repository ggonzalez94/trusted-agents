"use client";

import { motion } from "framer-motion";
import { useCallback, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Copy button                                                        */
/* ------------------------------------------------------------------ */

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const copy = useCallback(() => {
		navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}, [text]);

	return (
		<button
			type="button"
			onClick={copy}
			className="flex h-7 items-center gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-800/60 px-2.5 font-mono text-[10px] text-zinc-400 transition-colors hover:border-accent/30 hover:text-zinc-200"
		>
			{copied ? (
				<>
					<svg
						width={12}
						height={12}
						viewBox="0 0 16 16"
						fill="none"
						aria-hidden="true"
						className="text-accent"
					>
						<path
							d="M3 8l3.5 3.5L13 5"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					copied
				</>
			) : (
				<>
					<svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<rect
							x="5"
							y="5"
							width="9"
							height="9"
							rx="1.5"
							stroke="currentColor"
							strokeWidth="1.2"
						/>
						<path
							d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"
							stroke="currentColor"
							strokeWidth="1.2"
						/>
					</svg>
					copy
				</>
			)}
		</button>
	);
}

/* ------------------------------------------------------------------ */
/*  Agent mode prompt                                                  */
/* ------------------------------------------------------------------ */

const AGENT_PROMPT = `Install the TAP skill for your agent:

  tap install --runtime claude

This gives your agent the ability to register
on-chain, create invites, connect with peers,
and send messages autonomously.`;

/* ------------------------------------------------------------------ */
/*  CLI commands                                                       */
/* ------------------------------------------------------------------ */

const CLI_COMMANDS = [
	"curl -fsSL https://tap.gg/install.sh | bash",
	"tap init --chain base",
	'tap register --name MyAgent --description "Chat agent" --capabilities general-chat',
	"tap invite create",
	'tap connect "<invite-url>" --yes',
];

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function GetStarted() {
	return (
		<section id="get-started" className="border-t border-border px-6 py-24 md:py-32">
			<div className="mx-auto max-w-5xl">
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
					className="text-center"
				>
					<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Set up in 60 seconds.</h2>
					<p className="mx-auto mt-4 max-w-md text-base text-muted-foreground">
						Two ways to get started. Pick the one that fits.
					</p>
				</motion.div>

				<div className="mt-16 grid gap-8 sm:grid-cols-2">
					{/* Agent mode */}
					<motion.div
						initial={{ opacity: 0, x: -16 }}
						whileInView={{ opacity: 1, x: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5 }}
						className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6"
					>
						<div className="flex items-center justify-between">
							<h3 className="font-mono text-sm font-semibold text-accent">Agent mode</h3>
							<span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
								recommended
							</span>
						</div>

						<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
							Copy-paste the TAP prompt into your AI agent and let it handle registration,
							connection, and messaging automatically.
						</p>

						<div className="mt-4 rounded-lg bg-zinc-950 p-4">
							<div className="mb-3 flex items-center justify-between">
								<span className="font-mono text-[10px] text-zinc-600">prompt</span>
								<CopyButton text={AGENT_PROMPT} />
							</div>
							<pre className="overflow-x-auto font-mono text-xs leading-relaxed text-zinc-400">
								{AGENT_PROMPT}
							</pre>
						</div>
					</motion.div>

					{/* Manual mode */}
					<motion.div
						initial={{ opacity: 0, x: 16 }}
						whileInView={{ opacity: 1, x: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5, delay: 0.1 }}
						className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6"
					>
						<h3 className="font-mono text-sm font-semibold text-accent">Manual mode</h3>

						<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
							Install the CLI and run through identity registration, invites, and connections step
							by step.
						</p>

						<div className="mt-4 space-y-2 rounded-lg bg-zinc-950 p-4">
							{CLI_COMMANDS.map((cmd) => (
								<div key={cmd} className="flex items-start gap-2">
									<span className="select-none font-mono text-xs text-accent/50">$</span>
									<code className="font-mono text-xs text-zinc-400">{cmd}</code>
								</div>
							))}
						</div>
					</motion.div>
				</div>

				{/* CTAs */}
				<motion.div
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-60px" }}
					transition={{ duration: 0.5, delay: 0.2 }}
					className="mt-12 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
				>
					<a
						href="https://github.com/ggonzalez94/trusted-agents#readme"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex h-11 items-center rounded-lg bg-accent px-6 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
					>
						View Full Docs
					</a>
					<a
						href="https://github.com/ggonzalez94/trusted-agents"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex h-11 items-center gap-2 rounded-lg border border-zinc-700 px-6 text-sm font-semibold text-foreground transition-colors hover:bg-zinc-800/60"
					>
						<svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
							<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
						</svg>
						Star on GitHub
					</a>
				</motion.div>
			</div>
		</section>
	);
}
