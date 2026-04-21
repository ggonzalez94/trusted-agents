import { cn } from "@/lib/cn";

export function Separator({ className }: { className?: string }) {
	return <div className={cn("h-px bg-bg-divider", className)} />;
}
