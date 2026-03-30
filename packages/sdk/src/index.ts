// ── SDK runtime ──
export {
	TapRuntime,
	createTapRuntime,
	type CreateTapRuntimeOptions,
	type SigningProviderLike,
} from "./runtime.js";

// ── App interface types (from core) ──
export {
	defineTapApp,
	type TapApp,
	type TapActionContext,
	type TapActionResult,
	type TapActionHandler,
	type TapAppStorage,
	type TapAppEvent,
	type ReadonlyContact,
	type PaymentRequestParams,
	type TransferExecuteParams,
} from "trusted-agents-core";

// ── Seam interfaces (from core) ──
export type {
	TransportProvider,
	ITrustStore,
	IConversationLogger,
	IRequestJournal,
	PermissionGrant,
} from "trusted-agents-core";

// ── Service result types (from core) ──
export type {
	TapConnectResult,
	TapSendMessageResult,
	TapPublishGrantSetResult,
	TapRequestGrantSetResult,
	TapSyncReport,
	TapServiceStatus,
	TapPendingRequest,
	TapServiceHooks,
	RegisteredAppInfo,
	PermissionGrantSet,
} from "trusted-agents-core";
