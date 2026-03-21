"use client";

import { motion } from "framer-motion";

const LEFT_AGENT = {
	name: "AliceAgent",
	chain: "Base",
	chainId: "8453",
	caps: ["general-chat", "transfer"],
};

const RIGHT_AGENT = {
	name: "BobAgent",
	chain: "Base",
	chainId: "8453",
	caps: ["scheduler", "payments"],
};

const FORWARD_PARTICLES = [
	{ duration: 2.0, delay: 1.2, size: 6 },
	{ duration: 2.3, delay: 1.8, size: 5 },
	{ duration: 1.9, delay: 2.5, size: 6 },
	{ duration: 2.1, delay: 3.1, size: 4 },
];

const REVERSE_PARTICLES = [
	{ duration: 2.5, delay: 1.6, size: 4 },
	{ duration: 2.8, delay: 2.4, size: 3 },
];

function HexIcon() {
	return (
		<svg
			width={18}
			height={18}
			viewBox="0 0 20 20"
			fill="none"
			className="text-accent"
		>
			<path
				d="M10 1l7.66 4.42v8.84L10 18.68 2.34 14.26V5.42L10 1z"
				stroke="currentColor"
				strokeWidth="1.5"
			/>
		</svg>
	);
}

function AgentCard({
	agent,
	from,
	delay,
}: {
	agent: typeof LEFT_AGENT;
	from: "left" | "right";
	delay: number;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, x: from === "left" ? -60 : 60 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
			className="w-52 rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-4 backdrop-blur-sm"
		>
			<div className="flex items-center gap-2.5">
				<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800/80">
					<HexIcon />
				</div>
				<span className="text-sm font-semibold tracking-tight">
					{agent.name}
				</span>
				<div className="ml-auto h-2 w-2 animate-pulse rounded-full bg-accent shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
			</div>

			<div className="mt-3 flex items-center gap-2">
				<span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent">
					{agent.chain}
				</span>
				<span className="font-mono text-[10px] text-zinc-500">
					eip155:{agent.chainId}
				</span>
			</div>

			<div className="mt-2.5 flex flex-wrap gap-1">
				{agent.caps.map((c) => (
					<span
						key={c}
						className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
					>
						{c}
					</span>
				))}
			</div>
		</motion.div>
	);
}

function TrustBridge() {
	return (
		<motion.div
			initial={{ opacity: 0, scaleX: 0 }}
			animate={{ opacity: 1, scaleX: 1 }}
			transition={{ duration: 0.5, delay: 0.8 }}
			className="relative h-px w-36 flex-shrink-0"
			style={{ transformOrigin: "center" }}
		>
			{/* Bridge line */}
			<div className="absolute inset-0 bg-gradient-to-r from-accent/20 via-accent/40 to-accent/20" />

			{/* Glow halo */}
			<div className="absolute -inset-y-3 inset-x-0 bg-gradient-to-r from-transparent via-accent/8 to-transparent blur-md" />

			{/* Forward particles */}
			{FORWARD_PARTICLES.map((p, i) => (
				<motion.div
					key={`f${i}`}
					className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full bg-accent"
					style={{
						width: p.size,
						height: p.size,
						boxShadow: `0 0 ${p.size + 2}px ${Math.floor(p.size / 2)}px rgba(34,197,94,0.4)`,
					}}
					animate={{
						x: [-p.size, 144 + p.size],
						opacity: [0, 1, 1, 0],
					}}
					transition={{
						duration: p.duration,
						delay: p.delay,
						repeat: Number.POSITIVE_INFINITY,
						ease: "linear",
					}}
				/>
			))}

			{/* Reverse particles */}
			{REVERSE_PARTICLES.map((p, i) => (
				<motion.div
					key={`r${i}`}
					className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full bg-accent/60"
					style={{
						width: p.size,
						height: p.size,
						boxShadow: `0 0 ${p.size + 2}px ${Math.floor(p.size / 2)}px rgba(34,197,94,0.2)`,
					}}
					animate={{
						x: [p.size, -(144 + p.size)],
						opacity: [0, 0.7, 0.7, 0],
					}}
					transition={{
						duration: p.duration,
						delay: p.delay,
						repeat: Number.POSITIVE_INFINITY,
						ease: "linear",
					}}
				/>
			))}
		</motion.div>
	);
}

export function Hero() {
	return (
		<section className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-24">
			{/* Dot grid background */}
			<div
				className="absolute inset-0 opacity-40"
				style={{
					backgroundImage:
						"radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
				}}
			/>

			{/* Radial glow */}
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,rgba(34,197,94,0.06),transparent_60%)]" />

			<div className="relative z-10 mx-auto max-w-5xl">
				{/* Agent cards + bridge — desktop */}
				<div className="mb-16 hidden items-center justify-center md:flex">
					<AgentCard agent={LEFT_AGENT} from="left" delay={0.2} />
					<div className="mx-6">
						<TrustBridge />
					</div>
					<AgentCard agent={RIGHT_AGENT} from="right" delay={0.4} />
				</div>

				{/* Mobile: simplified agent pills */}
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ delay: 0.3, duration: 0.5 }}
					className="mb-10 flex items-center justify-center gap-3 md:hidden"
				>
					<span className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs text-zinc-300">
						AliceAgent
					</span>
					<motion.span
						animate={{ opacity: [0.4, 1, 0.4] }}
						transition={{
							duration: 2,
							repeat: Number.POSITIVE_INFINITY,
							ease: "easeInOut",
						}}
						className="font-mono text-sm text-accent"
					>
						⟷
					</motion.span>
					<span className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs text-zinc-300">
						BobAgent
					</span>
				</motion.div>

				{/* Text content */}
				<div className="text-center">
					<motion.h1
						initial={{ opacity: 0, y: 24 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, delay: 0.6, ease: "easeOut" }}
						className="text-4xl font-bold tracking-tight sm:text-5xl md:text-7xl"
					>
						Your agent. Their agent.{" "}
						<span className="text-accent">Connected.</span>
					</motion.h1>

					<motion.p
						initial={{ opacity: 0, y: 16 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, delay: 0.75, ease: "easeOut" }}
						className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg md:text-xl"
					>
						A local-first protocol for AI agents to discover, trust, and
						transact&nbsp;&mdash; on behalf of the humans who own them.
					</motion.p>

					<motion.div
						initial={{ opacity: 0, y: 16 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, delay: 0.9, ease: "easeOut" }}
						className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
					>
						<a
							href="#get-started"
							className="inline-flex h-12 items-center rounded-lg bg-accent px-8 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
						>
							Get Started
						</a>
						<a
							href="https://github.com/ggonzalez94/trusted-agents"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex h-12 items-center rounded-lg border border-border px-8 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
						>
							View on GitHub
						</a>
					</motion.div>
				</div>
			</div>
		</section>
	);
}
