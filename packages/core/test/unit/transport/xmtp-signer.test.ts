import { describe, expect, it } from "vitest";
import { createXmtpSigner } from "../../../src/transport/xmtp-signer.js";
import { ALICE } from "../../fixtures/test-keys.js";

describe("createXmtpSigner", () => {
	it("should create a signer with the correct identifier", () => {
		const signer = createXmtpSigner(ALICE.account);

		const identity = signer.getIdentifier();
		expect(identity.identifier.toLowerCase()).toBe(ALICE.address.toLowerCase());
		expect(identity.identifierKind).toBeDefined();
	});

	it("should have type EOA", () => {
		const signer = createXmtpSigner(ALICE.account);
		expect(signer.type).toBe("EOA");
	});

	it("should produce a valid signature as Uint8Array", async () => {
		const signer = createXmtpSigner(ALICE.account);
		const signature = await signer.signMessage("test message");

		expect(signature).toBeInstanceOf(Uint8Array);
		expect(signature.length).toBeGreaterThan(0);
	});
});
