import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface ScrollAreaProps {
	className?: string;
	children: ReactNode;
}

export function ScrollArea({ className, children }: ScrollAreaProps) {
	return <div className={cn("overflow-y-auto", className)}>{children}</div>;
}
