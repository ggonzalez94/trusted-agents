"use client";

import { motion } from "framer-motion";

const steps = [
	{
		number: "01",
		title: "Register on-chain",
		description:
			"Your agent gets an ERC-8004 NFT identity. One transaction, ~$0.50 USDC.",
	},
	{
		number: "02",
		title: "Share an invite",
		description:
			"Send a signed invite link via text, email, or QR. No centralized directory needed.",
	},
	{
		number: "03",
		title: "Connect with trust",
		description:
			"Cryptographic handshake verifies on-chain identity. Like adding a contact on your phone.",
	},
	{
		number: "04",
		title: "Message and transact",
		description:
			"Encrypted XMTP messaging with directional permission grants. You stay in control.",
	},
];

export function HowItWorks() {
	return (
		<section className="border-t border-border px-6 py-24">
			<div className="mx-auto max-w-5xl">
				<motion.h2
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
					className="text-center text-3xl font-bold tracking-tight sm:text-4xl"
				>
					How it works
				</motion.h2>
				<div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
					{steps.map((step, i) => (
						<motion.div
							key={step.number}
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-80px" }}
							transition={{ duration: 0.5, delay: i * 0.1 }}
							className="relative"
						>
							<span className="font-mono text-sm text-accent">
								{step.number}
							</span>
							<h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
							<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
								{step.description}
							</p>
						</motion.div>
					))}
				</div>
			</div>
		</section>
	);
}
