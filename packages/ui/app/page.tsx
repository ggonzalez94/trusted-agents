"use client";

import { Dashboard } from "@/components/Dashboard";
import { captureToken, getToken } from "@/lib/token";
import { useEffect, useState } from "react";

export default function HomePage() {
	const [bootstrapped, setBootstrapped] = useState(false);

	useEffect(() => {
		captureToken();
		setBootstrapped(true);
	}, []);

	if (!bootstrapped) {
		return null;
	}

	if (!getToken()) {
		return <NoTokenScreen />;
	}

	return <Dashboard />;
}

function NoTokenScreen() {
	return (
		<div className="h-screen grid place-items-center bg-bg-DEFAULT text-text">
			<div className="text-center max-w-md px-6">
				<div className="text-[10px] uppercase tracking-[0.18em] text-text-faint mb-3 font-mono">
					tapd dashboard
				</div>
				<div className="text-base font-semibold tracking-tight text-text mb-2">
					Missing bearer token
				</div>
				<div className="text-xs text-text-muted leading-relaxed">
					Open this dashboard via{" "}
					<code className="bg-bg-elevated px-1.5 py-0.5 rounded font-mono text-[11px] text-text">
						tap ui
					</code>{" "}
					so the local daemon can hand you an authenticated session URL.
				</div>
			</div>
		</div>
	);
}
