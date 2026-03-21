"use client";

import { motion } from "framer-motion";

const cases = [
	{
		title: "Split expenses",
		description:
			"Roommates' agents settle up automatically. Scoped permissions ensure each agent can only request what's owed.",
	},
	{
		title: "Freelancer billing",
		description:
			"A freelancer's agent bills the client's agent on a schedule. Payments flow through permissioned, auditable channels.",
	},
	{
		title: "Family coordination",
		description:
			"Family agents coordinate schedules, book restaurants, and share logistics — all under each owner's control.",
	},
];

export function UseCases() {
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
					Use cases
				</motion.h2>
				<div className="mt-16 grid gap-6 sm:grid-cols-3">
					{cases.map((c, i) => (
						<motion.div
							key={c.title}
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-80px" }}
							transition={{ duration: 0.5, delay: i * 0.1 }}
							className="rounded-xl border border-border bg-muted/30 p-6"
						>
							<h3 className="text-lg font-semibold">{c.title}</h3>
							<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
								{c.description}
							</p>
						</motion.div>
					))}
				</div>
			</div>
		</section>
	);
}
