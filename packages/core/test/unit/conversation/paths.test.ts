import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONVERSATIONS_DB_FILE,
	LEGACY_CONVERSATIONS_BACKUP_DIR,
	LEGACY_CONVERSATIONS_DIR,
	conversationsDbPath,
	legacyConversationsBackupDir,
	legacyConversationsDir,
} from "../../../src/conversation/index.js";

describe("conversation paths", () => {
	it("derives conversation state paths from the data directory", () => {
		expect(CONVERSATIONS_DB_FILE).toBe("conversations.db");
		expect(LEGACY_CONVERSATIONS_DIR).toBe("conversations");
		expect(LEGACY_CONVERSATIONS_BACKUP_DIR).toBe("conversations.bak");
		expect(conversationsDbPath("/tmp/tap-data")).toBe(join("/tmp/tap-data", "conversations.db"));
		expect(legacyConversationsDir("/tmp/tap-data")).toBe(join("/tmp/tap-data", "conversations"));
		expect(legacyConversationsBackupDir("/tmp/tap-data")).toBe(
			join("/tmp/tap-data", "conversations.bak"),
		);
		expect(legacyConversationsBackupDir("/tmp/tap-data", 2)).toBe(
			join("/tmp/tap-data", "conversations.bak.2"),
		);
	});
});
