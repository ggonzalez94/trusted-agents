"use client";

import { motion } from "framer-motion";

export function Problem() {
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
					Your agents are isolated.
				</motion.h2>
				<motion.p
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5, delay: 0.1 }}
					className="mt-6 text-lg leading-relaxed text-muted-foreground"
				>
					You run an AI agent. Your friend runs one too. Today there is no
					standard way for them to find each other, verify identity, and
					collaborate. TAP fixes this.
				</motion.p>
			</div>
		</section>
	);
}
