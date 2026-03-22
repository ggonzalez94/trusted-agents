"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";

/* ------------------------------------------------------------------ */
/*  Graph components                                                   */
/* ------------------------------------------------------------------ */

function HumanNode({
	label,
	delay,
	active,
}: {
	label: string;
	delay: number;
	active: boolean;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, scale: 0.8 }}
			animate={active ? { opacity: 1, scale: 1 } : {}}
			transition={{ duration: 0.5, delay }}
			className="flex flex-col items-center gap-2"
		>
			<div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 ring-1 ring-zinc-700">
				<svg
					width={20}
					height={20}
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
					className="text-zinc-400"
				>
					<circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
					<path
						d="M5 20c0-3.87 3.13-7 7-7s7 3.13 7 7"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
			</div>
			<span className="text-xs font-medium text-zinc-400">{label}</span>
		</motion.div>
	);
}

function AgentNode({
	label,
	delay,
	active,
}: {
	label: string;
	delay: number;
	active: boolean;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, scale: 0.8 }}
			animate={active ? { opacity: 1, scale: 1 } : {}}
			transition={{ duration: 0.5, delay }}
			className="flex flex-col items-center gap-2"
		>
			<div className="flex h-14 w-14 items-center justify-center rounded-xl border border-zinc-700/80 bg-zinc-900 ring-1 ring-accent/10">
				<svg
					width={22}
					height={22}
					viewBox="0 0 20 20"
					fill="none"
					aria-hidden="true"
					className="text-accent"
				>
					<path
						d="M10 1l7.66 4.42v8.84L10 18.68 2.34 14.26V5.42L10 1z"
						stroke="currentColor"
						strokeWidth="1.5"
					/>
				</svg>
			</div>
			<span className="font-mono text-[10px] font-medium text-accent/70">{label}</span>
			<span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[8px] text-accent/50">
				ERC-8004
			</span>
		</motion.div>
	);
}

function OwnershipLine({
	delay,
	active,
}: {
	delay: number;
	active: boolean;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, scaleY: 0 }}
			animate={active ? { opacity: 1, scaleY: 1 } : {}}
			transition={{ duration: 0.4, delay }}
			style={{ transformOrigin: "top" }}
			className="flex flex-col items-center"
		>
			<div className="h-8 w-px bg-gradient-to-b from-zinc-600 to-zinc-700" />
			<span className="mt-0.5 text-[8px] text-zinc-600">owns</span>
		</motion.div>
	);
}

function PermissionArrow({
	label,
	direction,
	delay,
	active,
}: {
	label: string;
	direction: "right" | "left";
	delay: number;
	active: boolean;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, scaleX: 0 }}
			animate={active ? { opacity: 1, scaleX: 1 } : {}}
			transition={{ duration: 0.5, delay }}
			style={{ transformOrigin: direction === "right" ? "left" : "right" }}
			className="flex flex-col items-center gap-1"
		>
			<span className="whitespace-nowrap rounded bg-zinc-900 px-2 py-0.5 font-mono text-[9px] text-zinc-500 ring-1 ring-zinc-800">
				{label}
			</span>
			<div className="flex items-center gap-0.5">
				{direction === "left" && (
					<svg
						width={6}
						height={8}
						viewBox="0 0 6 8"
						fill="none"
						aria-hidden="true"
						className="text-accent/50"
					>
						<path d="M5 1L1 4l4 3" fill="currentColor" />
					</svg>
				)}
				<div className="h-px w-16 bg-accent/30 sm:w-24" />
				{direction === "right" && (
					<svg
						width={6}
						height={8}
						viewBox="0 0 6 8"
						fill="none"
						aria-hidden="true"
						className="text-accent/50"
					>
						<path d="M1 1l4 3-4 3" fill="currentColor" />
					</svg>
				)}
			</div>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/*  Trust graph                                                        */
/* ------------------------------------------------------------------ */

function TrustGraph() {
	const ref = useRef<HTMLDivElement>(null);
	const isInView = useInView(ref, { once: true, margin: "-10%" });

	return (
		<div
			ref={ref}
			className="mx-auto mt-14 max-w-lg rounded-xl border border-zinc-800/50 bg-zinc-900/20 p-8 sm:p-10"
		>
			{/* Top row: Humans */}
			<div className="flex items-start justify-between px-4 sm:px-8">
				<HumanNode label="Alice" delay={0.2} active={isInView} />
				<HumanNode label="Bob" delay={0.4} active={isInView} />
			</div>

			{/* Ownership lines */}
			<div className="flex justify-between px-9 sm:px-14">
				<OwnershipLine delay={0.6} active={isInView} />
				<OwnershipLine delay={0.7} active={isInView} />
			</div>

			{/* Bottom row: Agents */}
			<div className="flex items-start justify-between px-2 sm:px-6">
				<AgentNode label="AliceAgent" delay={0.8} active={isInView} />
				<AgentNode label="BobAgent" delay={0.9} active={isInView} />
			</div>

			{/* Permission arrows — bidirectional with asymmetric scopes */}
			<div className="mt-6 space-y-2">
				<PermissionArrow label="10 USDC/week" direction="right" delay={1.2} active={isInView} />
				<PermissionArrow label="general-chat" direction="left" delay={1.5} active={isInView} />
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Key points                                                         */
/* ------------------------------------------------------------------ */

const points = [
	{
		title: "Own identity on-chain",
		description: "Each agent is an ERC-8004 NFT. You hold the key.",
	},
	{
		title: "Invite-only connections",
		description: "No discovery marketplace. Signed links, like contacts on your phone.",
	},
	{
		title: "Directional permissions",
		description: "Each side sets its own scopes and limits. Asymmetric by design.",
	},
	{
		title: "Everything is logged",
		description: "Every message, every transaction, reviewable by the owning human.",
	},
];

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function TrustModel() {
	return (
		<section className="border-t border-border px-6 py-24 md:py-32">
			<div className="mx-auto max-w-3xl">
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
					className="text-center"
				>
					<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
						Contacts list, not marketplace.
					</h2>
					<p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-muted-foreground">
						Every agent connection starts with a human relationship. You own your agent, you invite
						peers with signed links, and you control exactly what permissions each connection gets.
					</p>
				</motion.div>

				{/* Interactive graph */}
				<TrustGraph />

				{/* Key points grid */}
				<div className="mt-14 grid gap-6 sm:grid-cols-2">
					{points.map((point, i) => (
						<motion.div
							key={point.title}
							initial={{ opacity: 0, y: 16 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-60px" }}
							transition={{ duration: 0.4, delay: i * 0.1 }}
							className="rounded-lg border border-zinc-800/50 bg-zinc-900/20 p-4"
						>
							<h3 className="text-sm font-semibold">{point.title}</h3>
							<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
								{point.description}
							</p>
						</motion.div>
					))}
				</div>
			</div>
		</section>
	);
}
