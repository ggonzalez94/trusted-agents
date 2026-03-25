import { describe, expect, it } from "vitest";
import { createXmtpSigner } from "../../../src/transport/xmtp-signer.js";
import { ALICE, ALICE_SIGNING_PROVIDER } from "../../fixtures/test-keys.js";

describe("createXmtpSigner", () => {
	it("should create a signer with the correct identifier", async () => {
		const signer = await createXmtpSigner(ALICE_SIGNING_PROVIDER);

		const identity = signer.getIdentifier();
		expect(identity.identifier.toLowerCase()).toBe(ALICE.address.toLowerCase());
		expect(identity.identifierKind).toBeDefined();
	});

	it("should have type EOA", async () => {
		const signer = await createXmtpSigner(ALICE_SIGNING_PROVIDER);
		expect(signer.type).toBe("EOA");
	});

	it("should produce a valid signature as Uint8Array", async () => {
		const signer = await createXmtpSigner(ALICE_SIGNING_PROVIDER);
		const signature = await signer.signMessage("test message");

		expect(signature).toBeInstanceOf(Uint8Array);
		expect(signature.length).toBeGreaterThan(0);
	});
});
