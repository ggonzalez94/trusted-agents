import { cn } from "@/lib/cn";

type Size = "xs" | "sm" | "md" | "lg";
type Variant = "primary" | "warm" | "neutral";

interface AvatarProps {
	initials: string;
	size?: Size;
	variant?: Variant;
	className?: string;
}

const SIZE_STYLES: Record<Size, string> = {
	xs: "w-5 h-5 text-[9px] rounded",
	sm: "w-6 h-6 text-[10px] rounded-md",
	md: "w-7 h-7 text-[11px] rounded-md",
	lg: "w-9 h-9 text-xs rounded-lg",
};

const VARIANT_STYLES: Record<Variant, string> = {
	primary:
		"bg-gradient-to-br from-accent-primary to-accent-secondary text-white shadow-[0_4px_12px_-4px_rgba(99,102,241,0.5)]",
	warm:
		"bg-gradient-to-br from-amber-500 to-rose-600 text-white shadow-[0_4px_12px_-4px_rgba(244,114,182,0.4)]",
	neutral: "bg-bg-elevated text-text-dim",
};

export function Avatar({
	initials,
	size = "md",
	variant = "primary",
	className,
}: AvatarProps) {
	return (
		<div
			className={cn(
				"inline-flex items-center justify-center font-mono font-semibold tracking-tight flex-shrink-0 select-none",
				SIZE_STYLES[size],
				VARIANT_STYLES[variant],
				className,
			)}
		>
			{initials}
		</div>
	);
}
