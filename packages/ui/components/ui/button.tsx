import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
	children: ReactNode;
}

const VARIANT_STYLES: Record<Variant, string> = {
	primary:
		"bg-accent-primary text-white hover:bg-accent-primary/90 shadow-[0_1px_0_0_rgba(255,255,255,0.08)_inset]",
	ghost:
		"bg-transparent text-text-muted border border-bg-divider hover:text-text hover:border-text-dim",
	danger:
		"bg-transparent text-red-300 border border-red-400/30 hover:bg-red-400/10 hover:text-red-200",
};

const SIZE_STYLES: Record<Size, string> = {
	sm: "px-3 py-1.5 text-xs",
	md: "px-4 py-2 text-sm",
};

export function Button({
	variant = "primary",
	size = "md",
	className,
	children,
	type,
	...props
}: ButtonProps) {
	return (
		<button
			type={type ?? "button"}
			className={cn(
				"inline-flex items-center justify-center gap-1.5 rounded-lg font-medium tracking-tight transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-DEFAULT",
				"disabled:opacity-50 disabled:pointer-events-none",
				VARIANT_STYLES[variant],
				SIZE_STYLES[size],
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
