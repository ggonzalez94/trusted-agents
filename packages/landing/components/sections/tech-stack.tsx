"use client";

import { motion } from "framer-motion";

const badges = [
	"ERC-8004",
	"XMTP",
	"JSON-RPC 2.0",
	"Account Abstraction",
	"Open Source · MIT",
];

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
							key={badge}
							initial={{ opacity: 0, scale: 0.9 }}
							whileInView={{ opacity: 1, scale: 1 }}
							viewport={{ once: true }}
							transition={{ duration: 0.4, delay: i * 0.08 }}
							className="inline-flex items-center rounded-full border border-border bg-muted/30 px-4 py-2 font-mono text-sm text-muted-foreground"
						>
							{badge}
						</motion.span>
					))}
				</div>
			</div>
		</section>
	);
}
