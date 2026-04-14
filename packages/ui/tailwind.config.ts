import type { Config } from "tailwindcss";

const config: Config = {
	content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				bg: {
					DEFAULT: "#0e0e12",
					rail: "#0a0a0e",
					main: "#101015",
					card: "#15151d",
					elevated: "#1b1b23",
					subtle: "#17171d",
					border: "#1d1d22",
					divider: "#26262e",
					input: "#22222a",
				},
				text: {
					DEFAULT: "#e8e8ec",
					muted: "#8b8b95",
					dim: "#6b6b74",
					faint: "#5b5b63",
					ghost: "#3a3a42",
				},
				accent: {
					primary: "#6366f1",
					secondary: "#a855f7",
					success: "#4ade80",
					warning: "#fbbf24",
					info: "#4a9dff",
				},
			},
			fontFamily: {
				display: ['"Inter Tight"', "-apple-system", "system-ui", "sans-serif"],
				sans: ["-apple-system", '"SF Pro Text"', "system-ui", "sans-serif"],
				mono: ["ui-monospace", '"JetBrains Mono"', "SFMono-Regular", "Menlo", "monospace"],
			},
			borderRadius: {
				bubble: "14px",
				card: "12px",
				pill: "10px",
			},
			spacing: {
				"4.5": "1.125rem",
				"5.5": "1.375rem",
			},
		},
	},
	plugins: [],
};

export default config;
