import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

interface CardProps {
	className?: string;
	children: ReactNode;
}

export function Card({ className, children }: CardProps) {
	return (
		<div
			className={cn(
				"rounded-card border border-bg-divider bg-bg-card",
				"shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_24px_48px_-24px_rgba(0,0,0,0.6)]",
				className,
			)}
		>
			{children}
		</div>
	);
}
