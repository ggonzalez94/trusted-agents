"use client";

import { motion } from "framer-motion";

/* ------------------------------------------------------------------ */
/*  Badge icons (minimal SVGs)                                         */
/* ------------------------------------------------------------------ */

function NftIcon() {
	return (
		<svg width={16} height={16} viewBox="0 0 20 20" fill="none">
			<path
				d="M10 1l7.66 4.42v8.84L10 18.68 2.34 14.26V5.42L10 1z"
				stroke="currentColor"
				strokeWidth="1.5"
			/>
		</svg>
	);
}

function MessageIcon() {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" fill="none">
			<path
				d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function CodeIcon() {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" fill="none">
			<path
				d="M16 18l6-6-6-6M8 6l-6 6 6 6"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function WalletIcon() {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" fill="none">
			<rect
				x="2"
				y="6"
				width="20"
				height="14"
				rx="2"
				stroke="currentColor"
				strokeWidth="1.5"
			/>
			<path
				d="M2 10h20M16 14.5h2"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function OpenSourceIcon() {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" fill="none">
			<circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
			<path
				d="M12 3c-2 3.33-3 6.67-3 10s1 6.67 3 10M12 3c2 3.33 3 6.67 3 10s-1 6.67-3 10M3 12h18"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/* ------------------------------------------------------------------ */
/*  Badge data                                                         */
/* ------------------------------------------------------------------ */

const badges = [
	{ label: "ERC-8004", Icon: NftIcon },
	{ label: "XMTP", Icon: MessageIcon },
	{ label: "JSON-RPC 2.0", Icon: CodeIcon },
	{ label: "Account Abstraction", Icon: WalletIcon },
	{ label: "Open Source · MIT", Icon: OpenSourceIcon },
];

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function TechStack() {
	return (
		<section className="border-t border-border px-6 py-24">
			<div className="mx-auto max-w-3xl text-center">
				<motion.h2
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
					className="text-3xl font-bold tracking-tight sm:text-4xl"
				>
					Built on open standards
				</motion.h2>

				<div className="mt-10 flex flex-wrap justify-center gap-3">
					{badges.map((badge, i) => (
						<motion.span
							key={badge.label}
							initial={{ opacity: 0, scale: 0.9 }}
							whileInView={{ opacity: 1, scale: 1 }}
							viewport={{ once: true }}
							transition={{ duration: 0.4, delay: i * 0.08 }}
							whileHover={{
								scale: 1.05,
								borderColor: "rgba(34,197,94,0.3)",
								transition: { duration: 0.15 },
							}}
							className="inline-flex cursor-default items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/40 px-4 py-2 font-mono text-sm text-zinc-400 transition-colors hover:text-zinc-200"
						>
							<badge.Icon />
							{badge.label}
						</motion.span>
					))}
				</div>
			</div>
		</section>
	);
}
