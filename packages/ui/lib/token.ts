/**
 * Bearer-token bootstrap.
 *
 * The UI loads in a browser; the bearer token comes from the URL hash
 * (because the hash isn't sent to servers and doesn't appear in browser
 * history). On first load we capture the token, stash it in `sessionStorage`,
 * then strip the hash so the token doesn't leak into bookmarks.
 */

const STORAGE_KEY = "tapd-token";

export function captureToken(): void {
	if (typeof window === "undefined") return;

	const hash = window.location.hash.replace(/^#/, "");
	if (!hash) return;

	const params = new URLSearchParams(hash);
	const token = params.get("token");
	if (!token) return;

	sessionStorage.setItem(STORAGE_KEY, token);

	// Strip the hash so the token doesn't leak into bookmarks/history.
	const url = new URL(window.location.href);
	url.hash = "";
	window.history.replaceState({}, "", url.toString());
}

export function getToken(): string | null {
	if (typeof window === "undefined") return null;
	return sessionStorage.getItem(STORAGE_KEY);
}

export function clearToken(): void {
	if (typeof window === "undefined") return;
	sessionStorage.removeItem(STORAGE_KEY);
}
