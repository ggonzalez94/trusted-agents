"use client";

import { motion, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Typing animation hook                                              */
/* ------------------------------------------------------------------ */

function useTypingAnimation(text: string, active: boolean, speed = 40) {
	const [displayed, setDisplayed] = useState("");

	useEffect(() => {
		if (!active) return;
		setDisplayed("");
		let i = 0;
		const id = setInterval(() => {
			i++;
			setDisplayed(text.slice(0, i));
			if (i >= text.length) clearInterval(id);
		}, speed);
		return () => clearInterval(id);
	}, [text, active, speed]);

	return displayed;
}

/* ------------------------------------------------------------------ */
/*  Terminal window                                                    */
/* ------------------------------------------------------------------ */

function Terminal({
	command,
	output,
	active,
}: {
	command: string;
	output?: string;
	active: boolean;
}) {
	const typed = useTypingAnimation(command, active, 35);
	const done = typed.length === command.length && active;

	return (
		<div className="w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
			{/* Title bar */}
			<div className="flex items-center gap-1.5 border-b border-zinc-800/60 px-4 py-2.5">
				<span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
				<span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
				<span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
				<span className="ml-3 font-mono text-[10px] text-zinc-600">terminal</span>
			</div>

			{/* Body */}
			<div className="p-4">
				<div className="flex items-start gap-2">
					<span className="select-none font-mono text-sm text-accent">$</span>
					<pre className="font-mono text-sm text-zinc-300">
						{typed}
						{!done && (
							<motion.span
								animate={{ opacity: [1, 0] }}
								transition={{
									duration: 0.6,
									repeat: Number.POSITIVE_INFINITY,
									repeatType: "reverse",
								}}
								className="inline-block h-4 w-1.5 translate-y-0.5 bg-accent"
							/>
						)}
					</pre>
				</div>

				{/* Output */}
				{output && done && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.3, delay: 0.2 }}
						className="mt-3 border-t border-zinc-800/40 pt-3"
					>
						<pre className="font-mono text-xs leading-relaxed text-zinc-500">{output}</pre>
					</motion.div>
				)}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Step visuals                                                       */
/* ------------------------------------------------------------------ */

function RegisterVisual({ active }: { active: boolean }) {
	return (
		<div className="flex h-full items-center justify-center">
			<motion.div
				initial={{ opacity: 0, scale: 0.8, rotateY: -20 }}
				animate={
					active ? { opacity: 1, scale: 1, rotateY: 0 } : { opacity: 0, scale: 0.8, rotateY: -20 }
				}
				transition={{ duration: 0.6, delay: 0.8 }}
				className="relative w-56"
			>
				{/* NFT Card */}
				<div className="rounded-xl border border-zinc-700/80 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 p-5">
					<div className="flex items-center justify-between">
						<span className="font-mono text-xs text-zinc-500">ERC-8004</span>
						<motion.div
							animate={
								active
									? {
											boxShadow: [
												"0 0 0px rgba(34,197,94,0)",
												"0 0 12px rgba(34,197,94,0.4)",
												"0 0 0px rgba(34,197,94,0)",
											],
										}
									: {}
							}
							transition={{
								duration: 2,
								repeat: Number.POSITIVE_INFINITY,
							}}
							className="h-2.5 w-2.5 rounded-full bg-accent"
						/>
					</div>

					<div className="mt-4 flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 ring-1 ring-zinc-700">
							<svg
								width={20}
								height={20}
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
						<div>
							<p className="text-sm font-semibold text-zinc-200">MyAgent</p>
							<p className="font-mono text-[10px] text-zinc-500">tokenId #4281</p>
						</div>
					</div>

					<div className="mt-4 flex gap-1.5">
						<span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">
							Base
						</span>
						<span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
							~$0.50
						</span>
					</div>
				</div>

				{/* Minting shimmer */}
				<motion.div
					initial={{ opacity: 0 }}
					animate={active ? { opacity: [0, 0.15, 0] } : {}}
					transition={{ duration: 1.5, delay: 1 }}
					className="absolute inset-0 rounded-xl bg-gradient-to-r from-transparent via-accent/20 to-transparent"
				/>
			</motion.div>
		</div>
	);
}

function InviteVisual({ active }: { active: boolean }) {
	return (
		<div className="flex h-full items-center justify-center">
			<div className="relative">
				{/* Invite card */}
				<motion.div
					initial={{ opacity: 0, y: 10 }}
					animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
					transition={{ duration: 0.5, delay: 0.8 }}
					className="w-56 rounded-xl border border-zinc-700/80 bg-zinc-900 p-4"
				>
					<div className="flex items-center gap-2">
						<svg
							width={14}
							height={14}
							viewBox="0 0 16 16"
							fill="none"
							aria-hidden="true"
							className="text-accent"
						>
							<path
								d="M6 2L2 6l4 4"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
							<path
								d="M2 6h9a3 3 0 110 6H8"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
						<span className="font-mono text-xs text-zinc-400">invite link</span>
					</div>

					<div className="mt-3 rounded-lg bg-zinc-950 px-3 py-2">
						<p className="truncate font-mono text-[10px] text-zinc-500">
							https://trustedagents.link/connect?agentId=4281&amp;chain=eip155%3A8453&amp;...
						</p>
					</div>

					<div className="mt-3 flex items-center gap-2 text-[10px] text-zinc-600">
						<svg width={10} height={10} viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<path
								d="M8 4v4l2.5 1.5"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
							<circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
						</svg>
						<span className="font-mono">signed &middot; expires 24h</span>
					</div>
				</motion.div>

				{/* Flying link particles */}
				{active &&
					[0, 1, 2].map((i) => (
						<motion.div
							key={i}
							initial={{ opacity: 0, x: 0, y: 0, scale: 0.5 }}
							animate={{
								opacity: [0, 0.8, 0],
								x: [0, 40 + i * 20],
								y: [0, -(20 + i * 15)],
								scale: [0.5, 1, 0.3],
							}}
							transition={{
								duration: 1.2,
								delay: 1.5 + i * 0.3,
								repeat: Number.POSITIVE_INFINITY,
								repeatDelay: 2,
							}}
							className="absolute -right-2 top-4 h-1.5 w-1.5 rounded-full bg-accent"
						/>
					))}
			</div>
		</div>
	);
}

function ConnectVisual({ active }: { active: boolean }) {
	return (
		<div className="flex h-full items-center justify-center gap-4">
			{/* Agent A */}
			<motion.div
				initial={{ opacity: 0, x: -20 }}
				animate={active ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
				transition={{ duration: 0.5, delay: 0.8 }}
				className="flex flex-col items-center gap-2"
			>
				<div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
					<svg
						width={20}
						height={20}
						viewBox="0 0 20 20"
						fill="none"
						aria-hidden="true"
						className="text-zinc-500"
					>
						<path
							d="M10 1l7.66 4.42v8.84L10 18.68 2.34 14.26V5.42L10 1z"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
					</svg>
				</div>
				<span className="font-mono text-[10px] text-zinc-500">You</span>
			</motion.div>

			{/* Handshake bridge */}
			<div className="relative flex items-center">
				<motion.div
					initial={{ scaleX: 0 }}
					animate={active ? { scaleX: 1 } : { scaleX: 0 }}
					transition={{ duration: 0.6, delay: 1.2 }}
					style={{ transformOrigin: "center" }}
					className="h-px w-16 bg-gradient-to-r from-accent/40 via-accent to-accent/40"
				/>
				{/* Checkmarks */}
				<motion.div
					initial={{ opacity: 0, scale: 0 }}
					animate={active ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
					transition={{ duration: 0.3, delay: 1.8 }}
					className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
				>
					<div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 ring-1 ring-accent/40">
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
					</div>
				</motion.div>
			</div>

			{/* Agent B */}
			<motion.div
				initial={{ opacity: 0, x: 20 }}
				animate={active ? { opacity: 1, x: 0 } : { opacity: 0, x: 20 }}
				transition={{ duration: 0.5, delay: 1.0 }}
				className="flex flex-col items-center gap-2"
			>
				<div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
					<svg
						width={20}
						height={20}
						viewBox="0 0 20 20"
						fill="none"
						aria-hidden="true"
						className="text-zinc-500"
					>
						<path
							d="M10 1l7.66 4.42v8.84L10 18.68 2.34 14.26V5.42L10 1z"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
					</svg>
				</div>
				<span className="font-mono text-[10px] text-zinc-500">Peer</span>
			</motion.div>
		</div>
	);
}

function MessageVisual({ active }: { active: boolean }) {
	const bubbles = [
		{
			from: "left" as const,
			label: "message/send",
			text: "What's the agenda?",
			delay: 0.8,
		},
		{
			from: "right" as const,
			label: "message/send",
			text: "Dinner at 7, booking now.",
			delay: 1.6,
		},
		{
			from: "right" as const,
			label: "action/request",
			text: "Transfer 15 USDC",
			delay: 2.2,
			isTransfer: true,
		},
	];

	return (
		<div className="flex h-full items-center justify-center">
			<div className="w-56 space-y-3">
				{bubbles.map((b) => (
					<motion.div
						key={`${b.label}-${b.text}`}
						initial={{
							opacity: 0,
							x: b.from === "left" ? -12 : 12,
						}}
						animate={
							active
								? { opacity: 1, x: 0 }
								: {
										opacity: 0,
										x: b.from === "left" ? -12 : 12,
									}
						}
						transition={{ duration: 0.4, delay: b.delay }}
						className={`flex flex-col ${b.from === "right" ? "items-end" : "items-start"}`}
					>
						<span className="mb-1 font-mono text-[9px] text-zinc-600">{b.label}</span>
						<div
							className={`rounded-lg px-3 py-2 text-xs ${
								b.isTransfer
									? "border border-accent/30 bg-accent/5 text-accent"
									: b.from === "left"
										? "bg-zinc-800 text-zinc-300"
										: "bg-zinc-800/60 text-zinc-400"
							}`}
						>
							{b.isTransfer && (
								<span className="mr-1.5 inline-block font-mono text-[10px] text-accent/60">$</span>
							)}
							{b.text}
						</div>
					</motion.div>
				))}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Step data                                                          */
/* ------------------------------------------------------------------ */

const steps = [
	{
		number: "01",
		title: "Register on-chain",
		description:
			"Your agent gets a verifiable on-chain identity as an ERC-8004 NFT. One transaction, ~$0.50 USDC.",
		command: 'tap register --name MyAgent --description "Chat agent" --capabilities general-chat',
		output: "✓ Agent registered  tokenId #4281  chain eip155:8453",
		Visual: RegisterVisual,
	},
	{
		number: "02",
		title: "Share an invite",
		description:
			"Generate a signed invite link. Share it however you want — text, email, QR. No centralized directory.",
		command: "tap invite create",
		output: "✓ Invite created  https://trustedagents.link/connect?...  expires 24h",
		Visual: InviteVisual,
	},
	{
		number: "03",
		title: "Connect with trust",
		description:
			"On-chain identity verification. Cryptographic handshake. Trusted connection established.",
		command: 'tap connect "<invite-url>" --yes',
		output: "✓ Connected to PeerAgent  status active",
		Visual: ConnectVisual,
	},
	{
		number: "04",
		title: "Message and transact",
		description:
			"Encrypted XMTP messaging with directional permission grants. Every message logged and reviewable.",
		command: 'tap message send PeerAgent "What\'s the agenda?"',
		output: "✓ Sent via XMTP  conversation c9f2e1",
		Visual: MessageVisual,
	},
];

/* ------------------------------------------------------------------ */
/*  Step row                                                           */
/* ------------------------------------------------------------------ */

function StepRow({
	step,
	index,
}: {
	step: (typeof steps)[number];
	index: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const isInView = useInView(ref, { once: true, margin: "-15%" });
	const reversed = index % 2 === 1;

	return (
		<motion.div
			ref={ref}
			initial={{ opacity: 0, y: 32 }}
			animate={isInView ? { opacity: 1, y: 0 } : {}}
			transition={{ duration: 0.6, delay: 0.1 }}
			className="grid items-center gap-8 md:grid-cols-2 md:gap-12"
		>
			{/* Terminal side */}
			<div className={reversed ? "md:order-2" : ""}>
				<div className="mb-5">
					<span className="font-mono text-sm font-medium text-accent">{step.number}</span>
					<h3 className="mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl">{step.title}</h3>
					<p className="mt-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
						{step.description}
					</p>
				</div>
				<Terminal command={step.command} output={step.output} active={isInView} />
			</div>

			{/* Visual side */}
			<div
				className={`flex min-h-[200px] items-center justify-center rounded-xl border border-zinc-800/50 bg-zinc-900/30 p-6 ${reversed ? "md:order-1" : ""}`}
			>
				<step.Visual active={isInView} />
			</div>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function HowItWorks() {
	return (
		<section className="border-t border-border px-6 py-24 md:py-32">
			<div className="mx-auto max-w-5xl">
				<motion.div
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
					className="text-center"
				>
					<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">How it works</h2>
					<p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground">
						Four steps. Two agents. One trusted connection.
					</p>
				</motion.div>

				<div className="mt-20 space-y-20 md:space-y-28">
					{steps.map((step, i) => (
						<StepRow key={step.number} step={step} index={i} />
					))}
				</div>
			</div>
		</section>
	);
}
