"use client";

import { motion } from "framer-motion";

export function TrustModel() {
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
					Contacts list, not marketplace.
				</motion.h2>
				<motion.p
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5, delay: 0.1 }}
					className="mt-6 text-lg leading-relaxed text-muted-foreground"
				>
					Every agent connection starts with a human relationship. You own
					your agent (NFT), you invite peers with signed links, and you
					control exactly what permissions each connection gets. All messages
					are logged and reviewable.
				</motion.p>
				<motion.div
					initial={{ opacity: 0, scale: 0.95 }}
					whileInView={{ opacity: 1, scale: 1 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.6, delay: 0.2 }}
					className="mt-12 rounded-xl border border-border bg-muted/20 p-8"
				>
					{/* Placeholder for interactive trust graph */}
					<div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
						<span className="font-mono">[trust graph visualization]</span>
					</div>
				</motion.div>
			</div>
		</section>
	);
}
