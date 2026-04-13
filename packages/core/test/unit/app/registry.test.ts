import { describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import { type TapActionContext, defineTapApp } from "../../../src/app/types.js";
import { useTempDir } from "../../helpers/temp-dir.js";

// A simple in-memory test app
const testApp = defineTapApp({
	id: "test-betting",
	name: "Test Betting",
	version: "1.0.0",
	actions: {
		"bet/propose": {
			handler: async (ctx: TapActionContext) => ({
				success: true,
				data: { accepted: true, terms: ctx.payload.terms },
			}),
		},
		"bet/accept": {
			handler: async (_ctx: TapActionContext) => ({
				success: true,
				data: { confirmed: true },
			}),
		},
	},
	grantScopes: ["bet/propose"],
});

describe("TapAppRegistry", () => {
	const dir = useTempDir("tap-registry");

	it("reports no handler for unknown action types", async () => {
		const registry = new TapAppRegistry(dir.path);
		await registry.loadManifest();
		expect(registry.hasHandler("bet/propose")).toBe(false);
	});

	it("registers an app and routes to its handler", async () => {
		const registry = new TapAppRegistry(dir.path);
		registry.registerApp(testApp);
		expect(registry.hasHandler("bet/propose")).toBe(true);
		expect(registry.hasHandler("bet/accept")).toBe(true);
		expect(registry.hasHandler("unknown/action")).toBe(false);
	});

	it("returns the app for an action type", () => {
		const registry = new TapAppRegistry(dir.path);
		registry.registerApp(testApp);
		const app = registry.getAppForAction("bet/propose");
		expect(app).toBeDefined();
		expect(app!.id).toBe("test-betting");
	});

	it("rejects duplicate action type registrations", () => {
		const registry = new TapAppRegistry(dir.path);
		registry.registerApp(testApp);
		const duplicate = defineTapApp({
			id: "duplicate",
			name: "Duplicate",
			version: "1.0.0",
			actions: {
				"bet/propose": {
					handler: async () => ({ success: true }),
				},
			},
		});
		expect(() => registry.registerApp(duplicate)).toThrow(/already registered/);
	});

	it("unregisters an app", () => {
		const registry = new TapAppRegistry(dir.path);
		registry.registerApp(testApp);
		registry.unregisterApp("test-betting");
		expect(registry.hasHandler("bet/propose")).toBe(false);
	});

	it("lists registered apps", () => {
		const registry = new TapAppRegistry(dir.path);
		registry.registerApp(testApp);
		const apps = registry.listApps();
		expect(apps).toHaveLength(1);
		expect(apps[0].id).toBe("test-betting");
		expect(apps[0].actionTypes).toEqual(["bet/propose", "bet/accept"]);
	});
});
