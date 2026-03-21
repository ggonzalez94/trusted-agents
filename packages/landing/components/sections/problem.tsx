"use client";

import type { MotionValue } from "framer-motion";
import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";

function AgentNode({
	label,
	progress,
}: {
	label: string;
	progress: MotionValue<number>;
}) {
	const borderColor = useTransform(
		progress,
		[0, 1],
		["rgb(63, 63, 70)", "rgb(34, 197, 94)"],
	);
	const glowOpacity = useTransform(progress, [0, 1], [0, 0.5]);
	const scale = useTransform(progress, [0, 1], [0.9, 1]);

	return (
		<motion.div
			style={{ scale }}
			className="relative flex flex-col items-center gap-3"
		>
			<motion.div
				style={{ borderColor }}
				className="relative flex h-20 w-20 items-center justify-center rounded-full border-2 bg-zinc-900/80 sm:h-24 sm:w-24"
			>
				<svg
					width={28}
					height={28}
					viewBox="0 0 20 20"
					fill="none"
					className="text-zinc-500"
				>
					<path
						d="M10 1l7.66 4.42v8.84L10 18.68 2.34 14.26V5.42L10 1z"
						stroke="currentColor"
						strokeWidth="1.5"
					/>
				</svg>

				{/* Glow ring on connection */}
				<motion.div
					style={{ opacity: glowOpacity }}
					className="absolute -inset-1.5 rounded-full border border-accent/30 shadow-[0_0_24px_rgba(34,197,94,0.15)]"
				/>
			</motion.div>

			<span className="font-mono text-xs text-zinc-500">{label}</span>
		</motion.div>
	);
}

function ConnectionLine({
	progress,
}: {
	progress: MotionValue<number>;
}) {
	const solidScaleX = useTransform(progress, [0, 1], [0, 1]);
	const dashedOpacity = useTransform(progress, [0, 1], [1, 0]);
	const crossOpacity = useTransform(
		progress,
		[0, 0.4, 0.5, 1],
		[1, 1, 0, 0],
	);
	const checkOpacity = useTransform(
		progress,
		[0, 0.4, 0.6, 1],
		[0, 0, 0, 1],
	);

	return (
		<div className="relative flex items-center justify-center">
			<div className="relative h-px w-20 sm:w-28 md:w-40">
				{/* Dashed line — fades out */}
				<motion.div
					style={{ opacity: dashedOpacity }}
					className="absolute inset-0 border-t-2 border-dashed border-zinc-700"
				/>

				{/* Solid green line — scales in from center */}
				<motion.div
					style={{ scaleX: solidScaleX, transformOrigin: "center" }}
					className="absolute inset-0 h-px bg-gradient-to-r from-accent/40 via-accent to-accent/40"
				/>

				{/* Glow on solid line */}
				<motion.div
					style={{ scaleX: solidScaleX, opacity: solidScaleX, transformOrigin: "center" }}
					className="absolute -inset-y-2 bg-gradient-to-r from-transparent via-accent/10 to-transparent blur-sm"
				/>
			</div>

			{/* Status icon overlay */}
			<div className="absolute">
				<motion.span
					style={{ opacity: crossOpacity }}
					className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-base text-zinc-600"
				>
					✕
				</motion.span>
				<motion.span
					style={{ opacity: checkOpacity }}
					className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-base text-accent"
				>
					✓
				</motion.span>
			</div>
		</div>
	);
}

export function Problem() {
	const sectionRef = useRef<HTMLElement>(null);
	const { scrollYProgress } = useScroll({
		target: sectionRef,
		offset: ["start end", "center center"],
	});

	const progress = useTransform(scrollYProgress, [0.3, 0.85], [0, 1]);

	return (
		<section ref={sectionRef} className="border-t border-border px-6 py-24 md:py-32">
			<div className="mx-auto max-w-3xl">
				<div className="text-center">
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
						className="mt-6 text-base leading-relaxed text-muted-foreground sm:text-lg"
					>
						You run an AI agent. Your friend runs one too. Today there is no
						standard way for them to find each other, verify identity, and
						collaborate securely. No shared directory. No trust layer. No
						protocol.
					</motion.p>
				</div>

				{/* Connection visual */}
				<div className="mx-auto mt-16 flex items-center justify-center gap-2 sm:gap-4 md:gap-6">
					<AgentNode label="Your Agent" progress={progress} />
					<ConnectionLine progress={progress} />
					<AgentNode label="Their Agent" progress={progress} />
				</div>

				{/* TAP fixes this */}
				<motion.p
					initial={{ opacity: 0, y: 12 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-50px" }}
					transition={{ duration: 0.5, delay: 0.3 }}
					className="mt-14 text-center text-xl font-semibold text-accent sm:text-2xl"
					style={{ textShadow: "0 0 30px rgba(34,197,94,0.2)" }}
				>
					TAP fixes this.
				</motion.p>
			</div>
		</section>
	);
}
