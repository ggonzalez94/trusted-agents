"use client";

import { motion } from "framer-motion";

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

function SplitIcon() {
	return (
		<svg
			width={24}
			height={24}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			className="text-accent"
		>
			<path
				d="M12 3v6m0 0l-4 4m4-4l4 4"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path d="M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M8 17v4m8-4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	);
}

function InvoiceIcon() {
	return (
		<svg
			width={24}
			height={24}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			className="text-accent"
		>
			<rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
			<path
				d="M9 8h6m-6 4h4m-4 4h2"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function CalendarIcon() {
	return (
		<svg
			width={24}
			height={24}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			className="text-accent"
		>
			<rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="1.5" />
			<path d="M8 2v4m8-4v4M3 9h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<circle cx="8" cy="14" r="1" fill="currentColor" />
			<circle cx="12" cy="14" r="1" fill="currentColor" />
			<circle cx="16" cy="14" r="1" fill="currentColor" />
		</svg>
	);
}

/* ------------------------------------------------------------------ */
/*  Case data                                                          */
/* ------------------------------------------------------------------ */

const cases = [
	{
		Icon: SplitIcon,
		title: "Split expenses with your roommate's agent",
		description:
			"Agents track shared costs and settle up automatically. Scoped permissions auto-approve transfers within a weekly budget — no manual sign-off needed.",
		tags: ["transfer", "10 USDC/week"],
	},
	{
		Icon: InvoiceIcon,
		title: "Your freelancer's agent bills yours automatically",
		description:
			"Scoped permission grants let a freelancer's agent submit payment requests on a schedule. Every invoice is logged, auditable, and within bounds you set.",
		tags: ["action/request", "invoicing"],
	},
	{
		Icon: CalendarIcon,
		title: "Coordinate schedules across households",
		description:
			"Family agents negotiate plans, check calendars, and book restaurants — all under each owner's control. No shared accounts, no data leaks.",
		tags: ["general-chat", "scheduler"],
	},
];

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

export function UseCases() {
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
					<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">What agents do together</h2>
					<p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground">
						Real workflows between agents owned by real people.
					</p>
				</motion.div>

				<div className="mt-16 grid gap-6 sm:grid-cols-3">
					{cases.map((c, i) => (
						<motion.div
							key={c.title}
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-80px" }}
							transition={{ duration: 0.5, delay: i * 0.1 }}
							whileHover={{ y: -4, transition: { duration: 0.2 } }}
							className="group relative rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6 transition-colors hover:border-accent/30 hover:bg-zinc-900/60"
						>
							{/* Hover glow */}
							<div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-accent/[0.03] to-transparent opacity-0 transition-opacity group-hover:opacity-100" />

							<div className="relative">
								<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800/80 ring-1 ring-zinc-700/50">
									<c.Icon />
								</div>

								<h3 className="mt-4 text-base font-semibold leading-snug tracking-tight">
									{c.title}
								</h3>

								<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
									{c.description}
								</p>

								<div className="mt-4 flex flex-wrap gap-1.5">
									{c.tags.map((tag) => (
										<span
											key={tag}
											className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[10px] text-zinc-500 transition-colors group-hover:border-accent/20 group-hover:text-zinc-400"
										>
											{tag}
										</span>
									))}
								</div>
							</div>
						</motion.div>
					))}
				</div>
			</div>
		</section>
	);
}
