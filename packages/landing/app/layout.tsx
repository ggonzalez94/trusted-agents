import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "TAP — Trusted Agent Protocol",
	description:
		"A local-first protocol for AI agents to discover, trust, and transact on behalf of their human owners.",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} dark`}>
			<body className="min-h-screen antialiased">{children}</body>
		</html>
	);
}
