"use client";

import { motion } from "framer-motion";

/* ------------------------------------------------------------------ */
/*  Floating particles (subtle background decoration)                  */
/* ------------------------------------------------------------------ */

const PARTICLES = [
	{ x: "10%", y: "20%", size: 2, duration: 6, delay: 0 },
	{ x: "25%", y: "60%", size: 1.5, duration: 8, delay: 1 },
	{ x: "45%", y: "30%", size: 2.5, duration: 7, delay: 2 },
	{ x: "65%", y: "70%", size: 1.5, duration: 9, delay: 0.5 },
	{ x: "80%", y: "40%", size: 2, duration: 6.5, delay: 3 },
	{ x: "90%", y: "15%", size: 1.5, duration: 8, delay: 1.5 },
];

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function Footer() {
	return (
		<footer className="relative overflow-hidden border-t border-border px-6 py-16">
			{/* Particle background */}
			<div className="pointer-events-none absolute inset-0">
				{PARTICLES.map((p) => (
					<motion.div
						key={`${p.x}-${p.y}`}
						className="absolute rounded-full bg-accent/20"
						style={{
							left: p.x,
							top: p.y,
							width: p.size,
							height: p.size,
						}}
						animate={{
							y: [0, -12, 0],
							opacity: [0.2, 0.5, 0.2],
						}}
						transition={{
							duration: p.duration,
							delay: p.delay,
							repeat: Number.POSITIVE_INFINITY,
							ease: "easeInOut",
						}}
					/>
				))}
			</div>

			<div className="relative mx-auto flex max-w-5xl flex-col items-center justify-between gap-6 sm:flex-row">
				{/* Brand */}
				<div className="flex flex-col items-center gap-2 sm:items-start">
					<span className="font-mono text-sm font-semibold text-foreground">TAP</span>
					<span className="text-xs text-muted-foreground">Trusted Agent Protocol</span>
				</div>

				{/* Links */}
				<div className="flex items-center gap-6">
					<a
						href="https://github.com/ggonzalez94/trusted-agents"
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						<svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
							<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
						</svg>
						GitHub
					</a>
					<span className="inline-flex items-center rounded border border-zinc-800 bg-zinc-900/40 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
						MIT License
					</span>
				</div>
			</div>
		</footer>
	);
}
