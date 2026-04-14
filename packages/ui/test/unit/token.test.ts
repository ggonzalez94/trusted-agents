import { beforeEach, describe, expect, it } from "vitest";
import { captureToken, clearToken, getToken } from "../../lib/token.js";

describe("token bootstrap", () => {
	beforeEach(() => {
		sessionStorage.clear();
		window.history.replaceState({}, "", "/");
	});

	it("captures token from URL hash and stores it", () => {
		window.history.replaceState({}, "", "/#token=abc123");
		captureToken();
		expect(getToken()).toBe("abc123");
	});

	it("strips token from URL after capture", () => {
		window.history.replaceState({}, "", "/#token=abc123");
		captureToken();
		expect(window.location.hash).toBe("");
	});

	it("returns null when no token in hash and none stored", () => {
		captureToken();
		expect(getToken()).toBeNull();
	});

	it("preserves previously stored token when hash is empty", () => {
		sessionStorage.setItem("tapd-token", "stored");
		captureToken();
		expect(getToken()).toBe("stored");
	});

	it("overwrites stored token when new hash provided", () => {
		sessionStorage.setItem("tapd-token", "old");
		window.history.replaceState({}, "", "/#token=new");
		captureToken();
		expect(getToken()).toBe("new");
	});

	it("clearToken removes the stored token", () => {
		sessionStorage.setItem("tapd-token", "abc");
		clearToken();
		expect(getToken()).toBeNull();
	});

	it("ignores unrelated hash params", () => {
		window.history.replaceState({}, "", "/#other=x");
		captureToken();
		expect(getToken()).toBeNull();
	});
});
