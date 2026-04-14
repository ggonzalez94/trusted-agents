"use client";

import { Dashboard } from "@/components/Dashboard";
import { captureToken } from "@/lib/token";
import { useEffect, useState } from "react";

export default function HomePage() {
	// Capture the bearer token out of the URL hash on mount. The Dashboard
	// itself owns the `missing`/`present`/`expired` lifecycle after that —
	// including the re-auth screen we used to render here as NoTokenScreen.
	// See F2.2 for why centralizing this matters (daemon-restart recovery).
	const [bootstrapped, setBootstrapped] = useState(false);

	useEffect(() => {
		captureToken();
		setBootstrapped(true);
	}, []);

	if (!bootstrapped) {
		return null;
	}

	return <Dashboard />;
}
