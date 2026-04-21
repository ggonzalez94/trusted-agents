# tapd Phase 2: Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `packages/ui/` workspace — a Next.js 15 static-export web UI that talks to the `tapd` daemon (built in Phase 1) over its HTTP API and SSE stream. Renders the operator's agent-to-agent conversations as a Slack-style chat with inline action cards. Approve-in-place for pending decisions.

**Architecture:** Next.js 15 App Router with `output: 'export'`. Tailwind CSS + shadcn/ui primitives. SWR for REST fetching, native EventSource for SSE. All state comes from tapd at runtime; no server components. Page routing uses search params + client state, not dynamic file routes (because dynamic file routes need `generateStaticParams` which we cannot provide for user data). The single static bundle is served by `tapd` from `packages/tapd/dist/ui/` (built copy of `packages/ui/out/`).

**Tech stack:** Next.js 15 + React 19 (App Router default). Tailwind CSS 3. shadcn/ui (manually copied primitives, no CLI dependency). SWR for data fetching. Native `EventSource` for SSE. Playwright for the golden-path end-to-end test.

**Visual contract:** the spec at `docs/superpowers/specs/2026-04-13-tapd-and-web-ui-design.md` describes the target layout in full. The "Visual contract" section near the bottom enumerates every required UI element. **The implementer must read that section before building components.** If it disagrees with this plan on any visual detail, the spec wins.

**Required skill invocations** (mandatory at implementation time, do not skip):
- **`frontend-design:frontend-design`** — invoke once before building any visual component. Apply its principles (no generic AI aesthetics, custom theming, semantic structure) to every component you write.
- **`vercel-react-best-practices`** — invoke once before writing React/Next.js code. Apply its patterns (server vs client components — though we're static-exported, so everything is effectively client; minimal re-renders; correct effect cleanup).
- The spec's visual section is the design source of truth.

**Out of scope for Phase 2:** the composer is read-only (no write path to `message/send`); no auth flow beyond the bearer token in URL hash; no multi-identity workspace switcher; no LLM narrative; no real-time typing indicators (no XMTP primitive). Channel rail section is greyed-out placeholder only.

**Note for executors — TDD applies but is shaped differently for UI work.** For library code (`lib/api.ts`, `lib/events.ts`, formatters), TDD is straightforward: write the failing test, implement, verify. For visual components, the contract is "matches the spec's visual section + passes the Playwright golden path." Build the component, then verify visually + via Playwright. Don't over-test snapshot HTML — over-snapshot tests rot fast on UI work.

When you see this plan reference an API method, type, or endpoint, **verify against `packages/tapd/src/`** which now exists and is the contract. If the plan contradicts what tapd actually exposes, tapd wins.

---

## File map

```
packages/ui/
  package.json
  next.config.mjs
  tailwind.config.ts
  postcss.config.mjs
  tsconfig.json
  vitest.config.ts
  .gitignore                     # node_modules, .next, out
  app/
    layout.tsx                   # root layout, fonts, theme, token bootstrap
    page.tsx                     # main inbox page (3-pane shell + state)
    globals.css                  # Tailwind directives + theme tokens
  components/
    chat/
      Thread.tsx                 # main thread column for selected DM
      MessageBubble.tsx          # one chat bubble (incoming or outgoing)
      ActionCard.tsx             # transfer / scheduling / grant card variants
      Composer.tsx               # read-only composer footer
      EmptyState.tsx             # "select a conversation" placeholder
    rail/
      Sidebar.tsx                # left rail container
      IdentityHeader.tsx         # operator identity at the top
      DmList.tsx                 # list of direct connections
      DmListItem.tsx             # one row in DmList
      ChannelsPreview.tsx        # greyed-out channels section
    ui/                          # shadcn-style primitives we own
      button.tsx
      avatar.tsx
      card.tsx
      scroll-area.tsx
      separator.tsx
  lib/
    api.ts                       # typed REST client for tapd
    events.ts                    # SSE subscription + event typing
    types.ts                     # shared event/message/contact/conversation types
    format.ts                    # address, tokenId, chain, time formatters
    cn.ts                        # className merger (clsx + tailwind-merge)
    token.ts                     # bearer token bootstrap from URL hash
  test/
    unit/
      api.test.ts
      events.test.ts
      format.test.ts
      token.test.ts
    e2e/
      golden-path.spec.ts        # Playwright end-to-end against running tapd
  public/
    favicon.svg
```

**Modified in `packages/tapd/`** (small change so tapd serves the UI):

```
packages/tapd/src/http/server.ts        # add static asset handling for /, /_next/*
packages/tapd/src/http/static-assets.ts # NEW: tiny static file server
packages/tapd/test/unit/static-assets.test.ts
packages/tapd/package.json              # depend on packages/ui for the build copy
```

**Workspace root:**

```
package.json                            # add packages/ui to typecheck order, add ui:build script
```

---

## Task 1: Scaffold `packages/ui` workspace

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/next.config.mjs`
- Create: `packages/ui/tailwind.config.ts`
- Create: `packages/ui/postcss.config.mjs`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/.gitignore`
- Create: `packages/ui/app/layout.tsx`
- Create: `packages/ui/app/page.tsx`
- Create: `packages/ui/app/globals.css`
- Create: `packages/ui/lib/cn.ts`
- Modify: workspace root `package.json`

- [ ] **Step 1: Create `packages/ui/package.json`**

```json
{
  "name": "trusted-agents-ui",
  "version": "0.2.0-beta.6",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "next lint",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "swr": "^2.2.5",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.0",
    "lucide-react": "^0.460.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^25.3.3",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: false,
  reactStrictMode: true,
};

export default nextConfig;
```

- [ ] **Step 3: Create `tailwind.config.ts`**

```ts
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
        sans: ["-apple-system", "SF Pro Text", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        bubble: "14px",
        card: "12px",
        pill: "10px",
      },
    },
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 4: Create `postcss.config.mjs`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "out", "test/e2e"]
}
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx"],
    environment: "jsdom",
    testTimeout: 10000,
  },
});
```

Note: install `jsdom` and `@testing-library/react` if needed. Add to devDependencies in Step 1 if you anticipate component tests; keep it lean otherwise.

- [ ] **Step 7: Create `.gitignore`**

```
node_modules/
.next/
out/
*.tsbuildinfo
```

- [ ] **Step 8: Create `app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: dark;
}

html, body {
  height: 100%;
  background: theme('colors.bg.DEFAULT');
  color: theme('colors.text.DEFAULT');
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "ss01", "cv11";
}
```

- [ ] **Step 9: Create `app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "tapd",
  description: "Trusted Agents Protocol — local dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 10: Create stub `app/page.tsx`**

```tsx
export default function HomePage() {
  return <div className="h-full grid place-items-center">tapd</div>;
}
```

- [ ] **Step 11: Create `lib/cn.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 12: Update workspace root `package.json` typecheck order**

Add `bun run --cwd packages/ui typecheck` to the typecheck script (after `tapd typecheck`):

```
"typecheck": "bun run --cwd packages/core typecheck && bun run --cwd packages/core build && bun run --cwd packages/app-transfer typecheck && bun run --cwd packages/app-scheduling typecheck && bun run --cwd packages/sdk typecheck && bun run --cwd packages/sdk build && bun run --cwd packages/tapd typecheck && bun run --cwd packages/ui typecheck && bun run --cwd packages/cli typecheck && bun run --cwd packages/openclaw-plugin typecheck",
```

- [ ] **Step 13: Install workspace dependencies**

Run: `bun install`
Expected: lockfile updated, `packages/ui/node_modules` populated.

- [ ] **Step 14: Verify build works**

Run: `bun run --cwd packages/ui build`
Expected: build succeeds, `packages/ui/out/index.html` exists.

- [ ] **Step 15: Verify typecheck**

Run: `bun run --cwd packages/ui typecheck`
Expected: clean.

- [ ] **Step 16: Commit**

```bash
git add packages/ui package.json bun.lock
git commit -m "feat(ui): scaffold packages/ui Next.js workspace with static export"
```

---

## Task 2: Type definitions mirroring tapd's API surface

**Files:**
- Create: `packages/ui/lib/types.ts`

The UI needs the same types tapd exposes. Rather than re-declaring everything, define the minimum shapes the UI consumes and let TypeScript catch any drift at compile time during development.

- [ ] **Step 1: Create `lib/types.ts`**

Read `packages/tapd/src/http/routes/identity.ts`, `contacts.ts`, `conversations.ts`, `pending.ts`, `notifications.ts`, and `packages/core/src/runtime/event-types.ts` to understand the exact shapes returned by tapd.

Then create:

```ts
// Identity
export interface Identity {
  agentId: number;
  chain: string;
  address: string;
  displayName: string;
  dataDir: string;
}

// Contact (mirrors trusted-agents-core Contact)
export interface Contact {
  connectionId: string;
  peerAgentId: number;
  peerChain: string;
  peerOwnerAddress: string;
  peerDisplayName: string;
  peerAgentAddress: string;
  permissions: {
    grantedByMe: { version: string; updatedAt: string; grants: unknown[] };
    grantedByPeer: { version: string; updatedAt: string; grants: unknown[] };
  };
  establishedAt: string;
  lastContactAt: string;
  status: "connecting" | "active" | "idle" | "stale" | "revoked";
  expiresAt?: string;
}

// Conversation message
export interface ConversationMessage {
  messageId?: string;
  timestamp: string;
  direction: "incoming" | "outgoing";
  scope: string;
  content: string;
  humanApprovalRequired: boolean;
  humanApprovalGiven: boolean | null;
  humanApprovalAt?: string;
}

// Conversation log
export interface ConversationLog {
  conversationId: string;
  connectionId: string;
  peerAgentId: number;
  peerDisplayName: string;
  topic?: string;
  startedAt: string;
  lastMessageAt: string;
  lastReadAt?: string;
  status: "active" | "completed" | "archived";
  messages: ConversationMessage[];
}

// Pending decision
export interface PendingItem {
  requestId: string;
  method: string;
  peerAgentId: number;
  direction: string;
  kind?: string;
  status: string;
  correlationId?: string;
  createdAt?: string;
}

// Event union (mirrors core's TapEvent)
export interface BaseEvent {
  id: string;
  occurredAt: string;
  identityAgentId: number;
}

export interface PeerRef {
  connectionId: string;
  peerAgentId: number;
  peerName: string;
  peerChain: string;
}

export type ActionKind = "transfer" | "scheduling" | "grant";

export interface MessageReceivedEvent extends BaseEvent {
  type: "message.received";
  conversationId: string;
  peer: PeerRef;
  messageId: string;
  text: string;
  scope: string;
}

export interface MessageSentEvent extends BaseEvent {
  type: "message.sent";
  conversationId: string;
  peer: PeerRef;
  messageId: string;
  text: string;
  scope: string;
}

export interface ActionRequestedEvent extends BaseEvent {
  type: "action.requested";
  conversationId: string;
  peer: PeerRef;
  requestId: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  direction: "inbound" | "outbound";
}

export interface ActionCompletedEvent extends BaseEvent {
  type: "action.completed";
  conversationId: string;
  requestId: string;
  kind: ActionKind;
  result: Record<string, unknown>;
  txHash?: string;
  completedAt: string;
}

export interface ActionPendingEvent extends BaseEvent {
  type: "action.pending";
  conversationId: string;
  requestId: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  awaitingDecision: true;
}

export interface ConnectionEstablishedEvent extends BaseEvent {
  type: "connection.established";
  connectionId: string;
  peer: PeerRef;
}

export interface DaemonStatusEvent extends BaseEvent {
  type: "daemon.status";
  transportConnected: boolean;
  lastSyncAt?: string;
}

// Other event types: action.failed, pending.resolved, connection.requested,
// connection.failed, contact.updated. Add them when you need to render them.

export type TapEvent =
  | MessageReceivedEvent
  | MessageSentEvent
  | ActionRequestedEvent
  | ActionCompletedEvent
  | ActionPendingEvent
  | ConnectionEstablishedEvent
  | DaemonStatusEvent;
```

If tapd exposes additional fields you discover while wiring the UI, add them here.

- [ ] **Step 2: Verify typecheck**

Run: `bun run --cwd packages/ui typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/lib/types.ts
git commit -m "feat(ui): add typed shapes mirroring tapd HTTP API"
```

---

## Task 3: Bearer-token bootstrap

**Files:**
- Create: `packages/ui/lib/token.ts`
- Create: `packages/ui/test/unit/token.test.ts`

The UI loads in a browser. The bearer token comes from the URL hash (because hash isn't sent to servers / doesn't appear in browser history). On first load we capture the token, stash it in `sessionStorage`, then strip it from the URL.

- [ ] **Step 1: Write the failing token test**

Create `packages/ui/test/unit/token.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { captureToken, getToken, clearToken } from "../../lib/token.js";

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
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/ui test test/unit/token.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement**

Create `packages/ui/lib/token.ts`:

```ts
const STORAGE_KEY = "tapd-token";

export function captureToken(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const token = params.get("token");
  if (!token) return;

  sessionStorage.setItem(STORAGE_KEY, token);
  // Strip the token from the URL so it doesn't leak into bookmarks/history.
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
```

- [ ] **Step 4: Run tests**

Run: `bun run --cwd packages/ui test test/unit/token.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/lib/token.ts packages/ui/test/unit/token.test.ts
git commit -m "feat(ui): add bearer token bootstrap from URL hash"
```

---

## Task 4: API client

**Files:**
- Create: `packages/ui/lib/api.ts`
- Create: `packages/ui/test/unit/api.test.ts`

A typed REST client for tapd. Reads the bearer token from `lib/token.ts` and sets the `Authorization` header on every request. Returns parsed JSON. Throws on non-2xx with error details.

- [ ] **Step 1: Write the failing API test**

Create `packages/ui/test/unit/api.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { TapdClient } from "../../lib/api.js";

describe("TapdClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem("tapd-token", "test-token");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes bearer token on GET requests", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ agentId: 42 }), { status: 200 }),
    );
    const client = new TapdClient("http://localhost:6810");
    await client.getIdentity();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token");
  });

  it("returns parsed JSON on success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ agentId: 42, displayName: "Alice" }), { status: 200 }),
    );
    const client = new TapdClient("http://localhost:6810");
    const result = await client.getIdentity();
    expect(result.agentId).toBe(42);
  });

  it("throws on non-2xx with error code", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), {
        status: 404,
      }),
    );
    const client = new TapdClient("http://localhost:6810");
    await expect(client.getIdentity()).rejects.toThrow(/not_found/);
  });

  it("approves a pending item with POST", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ resolved: true }), { status: 200 }),
    );
    const client = new TapdClient("http://localhost:6810");
    await client.approvePending("req-1", "looks good");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/pending/req-1/approve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ note: "looks good" });
  });

  it("denies a pending item with reason", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ resolved: true }), { status: 200 }),
    );
    const client = new TapdClient("http://localhost:6810");
    await client.denyPending("req-2", "policy");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/pending/req-2/deny");
    expect(JSON.parse(init.body)).toEqual({ reason: "policy" });
  });

  it("marks a conversation as read", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new TapdClient("http://localhost:6810");
    await client.markConversationRead("conv-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/conversations/conv-1/mark-read");
    expect(init.method).toBe("POST");
  });

  it("lists contacts", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ connectionId: "a" }]), { status: 200 }),
    );
    const client = new TapdClient("http://localhost:6810");
    const result = await client.listContacts();
    expect(result).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/ui test test/unit/api.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the API client**

Create `packages/ui/lib/api.ts`:

```ts
import type {
  Contact,
  ConversationLog,
  Identity,
  PendingItem,
} from "./types.js";
import { getToken } from "./token.js";

export interface TapdError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class TapdApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TapdApiError";
  }
}

export class TapdClient {
  constructor(private readonly baseUrl: string) {}

  async getIdentity(): Promise<Identity> {
    return this.get<Identity>("/api/identity");
  }

  async listContacts(): Promise<Contact[]> {
    return this.get<Contact[]>("/api/contacts");
  }

  async getContact(connectionId: string): Promise<Contact | null> {
    return this.get<Contact | null>(`/api/contacts/${encodeURIComponent(connectionId)}`);
  }

  async listConversations(): Promise<ConversationLog[]> {
    return this.get<ConversationLog[]>("/api/conversations");
  }

  async getConversation(id: string): Promise<ConversationLog | null> {
    return this.get<ConversationLog | null>(`/api/conversations/${encodeURIComponent(id)}`);
  }

  async listPending(): Promise<PendingItem[]> {
    return this.get<PendingItem[]>("/api/pending");
  }

  async approvePending(id: string, note?: string): Promise<{ resolved: true }> {
    return this.post(`/api/pending/${encodeURIComponent(id)}/approve`, note ? { note } : {});
  }

  async denyPending(id: string, reason?: string): Promise<{ resolved: true }> {
    return this.post(`/api/pending/${encodeURIComponent(id)}/deny`, reason ? { reason } : {});
  }

  async markConversationRead(id: string): Promise<{ ok: true }> {
    return this.post(`/api/conversations/${encodeURIComponent(id)}/mark-read`, {});
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.parse<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(response);
  }

  private headers(): Record<string, string> {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error = (body as { error?: TapdError } | undefined)?.error;
      throw new TapdApiError(
        error?.code ?? "unknown_error",
        error?.message ?? response.statusText,
        response.status,
        error?.details,
      );
    }
    return body as T;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun run --cwd packages/ui test test/unit/api.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/lib/api.ts packages/ui/test/unit/api.test.ts
git commit -m "feat(ui): add typed REST client for tapd"
```

---

## Task 5: SSE event subscription

**Files:**
- Create: `packages/ui/lib/events.ts`
- Create: `packages/ui/test/unit/events.test.ts`

The SSE client wraps native `EventSource` (which the browser provides). Note: native `EventSource` does NOT support custom headers, so the bearer token must be passed via query string for the SSE endpoint specifically. Tapd's auth middleware accepts `?token=...` on the SSE endpoint as well — verify in `packages/tapd/src/http/auth.ts` and add support if not already present.

**Important:** Check `packages/tapd/src/http/auth.ts`. If it does not currently accept `?token=...` as a fallback for the bearer header on the SSE route, you'll need to add support. This is a small but mandatory tapd modification for Phase 2 to work.

- [ ] **Step 1: Verify and (if needed) extend tapd auth to accept token query param**

Read `packages/tapd/src/http/auth.ts`. If it only checks the `Authorization` header, modify it to also accept a `?token=...` query parameter as a fallback for SSE compatibility. The fallback should be opt-in via the request URL — no security regression because the constant-time comparison still applies.

If you modify tapd auth, also write/update tests in `packages/tapd/test/unit/http-server.test.ts` to cover the query-param case. Commit that as a separate `fix(tapd): accept ?token query param for SSE` commit before continuing with Phase 2.

- [ ] **Step 2: Write the failing events test**

Create `packages/ui/test/unit/events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "../../lib/events.js";

class FakeEventSource {
  public onopen: (() => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onmessage: ((e: MessageEvent) => void) | null = null;
  public readyState = 0;
  public closed = false;
  private listeners = new Map<string, (e: MessageEvent) => void>();

  constructor(public readonly url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void): void {
    this.listeners.set(type, handler);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, payload: unknown, id?: string): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload), lastEventId: id });
    this.listeners.get(type)?.(event);
  }
}

describe("EventStream", () => {
  let createdSources: FakeEventSource[];

  beforeEach(() => {
    createdSources = [];
    vi.stubGlobal(
      "EventSource",
      vi.fn((url: string) => {
        const source = new FakeEventSource(url);
        createdSources.push(source);
        return source;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens an EventSource against the given URL with token query param", () => {
    const stream = new EventStream("http://localhost:6810", "abc-token", () => {});
    stream.start();
    expect(createdSources[0].url).toContain("/api/events/stream");
    expect(createdSources[0].url).toContain("token=abc-token");
  });

  it("dispatches typed events to the handler", () => {
    const events: unknown[] = [];
    const stream = new EventStream("http://localhost:6810", "abc", (event) => events.push(event));
    stream.start();
    createdSources[0].emit("message.received", {
      id: "evt-1",
      type: "message.received",
      occurredAt: "2026-04-01T00:00:00.000Z",
      identityAgentId: 42,
      conversationId: "conv-1",
      peer: { connectionId: "c", peerAgentId: 99, peerName: "Bob", peerChain: "eip155:8453" },
      messageId: "m-1",
      text: "hello",
      scope: "default",
    });

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("message.received");
  });

  it("closes the EventSource on stop()", () => {
    const stream = new EventStream("http://localhost:6810", "abc", () => {});
    stream.start();
    stream.stop();
    expect(createdSources[0].closed).toBe(true);
  });

  it("sends Last-Event-ID on reconnect", () => {
    const stream = new EventStream("http://localhost:6810", "abc", () => {});
    stream.start();
    createdSources[0].emit(
      "message.received",
      {
        id: "evt-1",
        type: "message.received",
        occurredAt: "x",
        identityAgentId: 1,
        conversationId: "c",
        peer: { connectionId: "c", peerAgentId: 1, peerName: "B", peerChain: "x" },
        messageId: "m",
        text: "h",
        scope: "default",
      },
      "evt-1",
    );
    stream.reconnect();
    expect(createdSources[1].url).toContain("lastEventId=evt-1");
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `bun run --cwd packages/ui test test/unit/events.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement**

Create `packages/ui/lib/events.ts`:

```ts
import type { TapEvent } from "./types.js";

const EVENT_TYPES: TapEvent["type"][] = [
  "message.received",
  "message.sent",
  "action.requested",
  "action.completed",
  "action.pending",
  "connection.established",
  "daemon.status",
];

export type EventHandler = (event: TapEvent) => void;

export class EventStream {
  private source: EventSource | null = null;
  private lastEventId: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly handler: EventHandler,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  reconnect(): void {
    this.stop();
    this.connect();
  }

  private connect(): void {
    const url = new URL(`${this.baseUrl}/api/events/stream`);
    url.searchParams.set("token", this.token);
    if (this.lastEventId) {
      url.searchParams.set("lastEventId", this.lastEventId);
    }
    this.source = new EventSource(url.toString());

    for (const type of EVENT_TYPES) {
      this.source.addEventListener(type, (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as TapEvent;
          this.lastEventId = payload.id;
          this.handler(payload);
        } catch {
          // Malformed event — drop silently. tapd is a trusted local source.
        }
      });
    }
  }
}
```

Note: the `lastEventId` query param on reconnect is a fallback because native `EventSource` automatically sends `Last-Event-ID` on reconnects but we explicitly include it as a query so tapd's handler can read it from either place. **You may need to extend tapd's SSE handler to read the query param** in addition to the header. Verify by reading `packages/tapd/src/http/sse.ts`.

- [ ] **Step 5: Run tests**

Run: `bun run --cwd packages/ui test test/unit/events.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/lib/events.ts packages/ui/test/unit/events.test.ts
git commit -m "feat(ui): add SSE event stream client with reconnect"
```

---

## Task 6: Formatters

**Files:**
- Create: `packages/ui/lib/format.ts`
- Create: `packages/ui/test/unit/format.test.ts`

Pure functions for formatting addresses, agent IDs, chain pills, and timestamps. Used everywhere in the UI.

- [ ] **Step 1: Write failing test**

Create `packages/ui/test/unit/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  formatAddress,
  formatChain,
  formatAgentId,
  formatRelativeTime,
  formatInitials,
} from "../../lib/format.js";

describe("format", () => {
  describe("formatAddress", () => {
    it("truncates the middle of an Ethereum address", () => {
      expect(formatAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    });

    it("returns short addresses unchanged", () => {
      expect(formatAddress("0xabc")).toBe("0xabc");
    });
  });

  describe("formatChain", () => {
    it("formats Base mainnet", () => {
      expect(formatChain("eip155:8453")).toBe("base");
    });

    it("formats Taiko mainnet", () => {
      expect(formatChain("eip155:167000")).toBe("taiko");
    });

    it("falls back to the CAIP-2 string for unknown chains", () => {
      expect(formatChain("eip155:99999")).toBe("eip155:99999");
    });
  });

  describe("formatAgentId", () => {
    it("renders agent IDs with a hash prefix", () => {
      expect(formatAgentId(42)).toBe("#42");
    });
  });

  describe("formatInitials", () => {
    it("returns first two letters uppercased", () => {
      expect(formatInitials("Alice")).toBe("AL");
    });

    it("handles single-word names", () => {
      expect(formatInitials("Bob")).toBe("BO");
    });

    it("handles short names", () => {
      expect(formatInitials("X")).toBe("X");
    });

    it("returns empty for empty string", () => {
      expect(formatInitials("")).toBe("");
    });
  });

  describe("formatRelativeTime", () => {
    it("returns 'just now' for very recent timestamps", () => {
      const now = new Date();
      expect(formatRelativeTime(now.toISOString(), now)).toBe("just now");
    });

    it("returns minute counts under an hour", () => {
      const now = new Date("2026-04-01T12:00:00Z");
      const past = new Date("2026-04-01T11:55:00Z");
      expect(formatRelativeTime(past.toISOString(), now)).toBe("5m ago");
    });

    it("returns hour counts under a day", () => {
      const now = new Date("2026-04-01T12:00:00Z");
      const past = new Date("2026-04-01T09:00:00Z");
      expect(formatRelativeTime(past.toISOString(), now)).toBe("3h ago");
    });

    it("returns day counts under a week", () => {
      const now = new Date("2026-04-08T12:00:00Z");
      const past = new Date("2026-04-05T12:00:00Z");
      expect(formatRelativeTime(past.toISOString(), now)).toBe("3d ago");
    });
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/ui test test/unit/format.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ui/lib/format.ts`:

```ts
const CHAIN_NAMES: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:167000": "taiko",
  "eip155:1": "ethereum",
  "eip155:10": "optimism",
  "eip155:42161": "arbitrum",
};

export function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatChain(caip2: string): string {
  return CHAIN_NAMES[caip2] ?? caip2;
}

export function formatAgentId(agentId: number): string {
  return `#${agentId}`;
}

export function formatInitials(name: string): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (trimmed.length <= 2) return trimmed.toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export function formatRelativeTime(isoString: string, now: Date = new Date()): string {
  const past = new Date(isoString);
  const diffMs = now.getTime() - past.getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 30) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.round(diffSec / 86400)}d ago`;

  return past.toLocaleDateString();
}
```

- [ ] **Step 4: Run tests**

Run: `bun run --cwd packages/ui test test/unit/format.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/lib/format.ts packages/ui/test/unit/format.test.ts
git commit -m "feat(ui): add address/chain/time formatters"
```

---

## Task 7: shadcn-style UI primitives

**Files:**
- Create: `packages/ui/components/ui/button.tsx`
- Create: `packages/ui/components/ui/avatar.tsx`
- Create: `packages/ui/components/ui/card.tsx`
- Create: `packages/ui/components/ui/scroll-area.tsx`
- Create: `packages/ui/components/ui/separator.tsx`

These are minimal, hand-written shadcn-style primitives. Do not use the shadcn CLI — copy minimal versions manually so we own them and they integrate with our theme tokens directly.

**Before starting this task: invoke `frontend-design:frontend-design`.** Apply its principles when shaping these primitives.

- [ ] **Step 1: Create `components/ui/button.tsx`**

```tsx
import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  children: ReactNode;
}

const variantStyles: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-accent-primary text-white hover:bg-accent-primary/90",
  ghost: "bg-transparent text-text-muted border border-bg-divider hover:text-text hover:border-text-dim",
  danger: "bg-transparent text-red-400 border border-red-400/30 hover:bg-red-400/10",
};

const sizeStyles: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Create `components/ui/avatar.tsx`**

```tsx
import { cn } from "@/lib/cn";

interface AvatarProps {
  initials: string;
  size?: "xs" | "sm" | "md" | "lg";
  variant?: "primary" | "warm" | "neutral";
  className?: string;
}

const sizeMap = {
  xs: "w-5 h-5 text-[9px] rounded",
  sm: "w-6 h-6 text-[10px] rounded-md",
  md: "w-7 h-7 text-[11px] rounded-md",
  lg: "w-8 h-8 text-xs rounded-lg",
};

const variantMap = {
  primary: "bg-gradient-to-br from-accent-primary to-accent-secondary text-white",
  warm: "bg-gradient-to-br from-amber-500 to-red-500 text-white",
  neutral: "bg-bg-elevated text-text-dim",
};

export function Avatar({ initials, size = "md", variant = "primary", className }: AvatarProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center justify-center font-semibold flex-shrink-0",
        sizeMap[size],
        variantMap[variant],
        className,
      )}
    >
      {initials}
    </div>
  );
}
```

- [ ] **Step 3: Create `components/ui/card.tsx`**

```tsx
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-card border border-bg-divider bg-bg-card", className)}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Create `components/ui/separator.tsx`**

```tsx
import { cn } from "@/lib/cn";

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px bg-bg-divider", className)} />;
}
```

- [ ] **Step 5: Create `components/ui/scroll-area.tsx`**

A minimal scrollable container that uses Tailwind's overflow utilities — no Radix dep needed for v1.

```tsx
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export function ScrollArea({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-y-auto scrollbar-thin scrollbar-thumb-bg-divider scrollbar-track-transparent",
        className,
      )}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 6: Verify build still works**

Run: `bun run --cwd packages/ui build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/components/ui
git commit -m "feat(ui): add hand-written shadcn-style primitives"
```

---

## Task 8: Sidebar (rail) components

**Files:**
- Create: `packages/ui/components/rail/IdentityHeader.tsx`
- Create: `packages/ui/components/rail/DmListItem.tsx`
- Create: `packages/ui/components/rail/DmList.tsx`
- Create: `packages/ui/components/rail/ChannelsPreview.tsx`
- Create: `packages/ui/components/rail/Sidebar.tsx`

The left rail. Three sections: identity header, DMs list, greyed-out channels placeholder.

**Visual contract:** read the spec at `docs/superpowers/specs/2026-04-13-tapd-and-web-ui-design.md`, particularly the appendix describing the chat-metaphor mockup, before building. The sidebar is 240px wide, has a left border separating it from the main column, dark background, identity header at top, DM list with avatar+name+unread dot, greyed-out channels section.

- [ ] **Step 1: Create `IdentityHeader.tsx`**

```tsx
import { Avatar } from "@/components/ui/avatar";
import { formatAgentId, formatChain, formatInitials } from "@/lib/format";
import type { Identity } from "@/lib/types";

export function IdentityHeader({ identity }: { identity: Identity }) {
  return (
    <div className="px-4 py-3.5 border-b border-bg-border">
      <div className="flex items-center gap-2.5">
        <Avatar initials={formatInitials(identity.displayName)} size="lg" />
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{identity.displayName || "Agent"}</div>
          <div className="text-[11px] text-text-dim">
            {formatAgentId(identity.agentId)} · {formatChain(identity.chain)}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `DmListItem.tsx`**

```tsx
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { formatInitials } from "@/lib/format";
import type { Contact } from "@/lib/types";

interface DmListItemProps {
  contact: Contact;
  active: boolean;
  unread: boolean;
  onClick: () => void;
}

export function DmListItem({ contact, active, unread, onClick }: DmListItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full mx-1.5 px-3 py-2 rounded-md flex items-center gap-2.5 text-sm transition-colors",
        active ? "bg-bg-elevated" : "hover:bg-bg-subtle",
      )}
    >
      <Avatar initials={formatInitials(contact.peerDisplayName)} size="sm" />
      <span className="flex-1 text-left truncate">{contact.peerDisplayName}</span>
      {unread && <span className="w-1.5 h-1.5 rounded-full bg-accent-primary" />}
    </button>
  );
}
```

- [ ] **Step 3: Create `DmList.tsx`**

```tsx
import { DmListItem } from "./DmListItem";
import type { Contact, ConversationLog } from "@/lib/types";

interface DmListProps {
  contacts: Contact[];
  conversations: ConversationLog[];
  selectedConnectionId: string | null;
  onSelect: (connectionId: string) => void;
}

export function DmList({ contacts, conversations, selectedConnectionId, onSelect }: DmListProps) {
  const conversationByConnection = new Map(
    conversations.map((c) => [c.connectionId, c]),
  );

  return (
    <div>
      <div className="px-3 pt-3 pb-1.5 text-[11px] uppercase tracking-wider text-text-dim">
        Direct
      </div>
      <div className="space-y-0.5">
        {contacts
          .filter((contact) => contact.status === "active")
          .map((contact) => {
            const log = conversationByConnection.get(contact.connectionId);
            const unread = !!log && (!log.lastReadAt || log.lastReadAt < log.lastMessageAt);
            return (
              <DmListItem
                key={contact.connectionId}
                contact={contact}
                active={selectedConnectionId === contact.connectionId}
                unread={unread}
                onClick={() => onSelect(contact.connectionId)}
              />
            );
          })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `ChannelsPreview.tsx`**

```tsx
export function ChannelsPreview() {
  return (
    <div>
      <div className="px-3 pt-4 pb-1.5 text-[11px] uppercase tracking-wider text-text-dim flex items-center justify-between">
        <span>Channels</span>
        <span className="text-text-ghost normal-case tracking-normal text-[10px]">soon</span>
      </div>
      <div className="space-y-0.5 opacity-50 pointer-events-none">
        <div className="mx-1.5 px-3 py-2 rounded-md flex items-center gap-2.5 text-sm">
          <div className="w-6 h-6 rounded-md bg-bg-elevated text-text-dim flex items-center justify-center text-[10px] font-semibold">
            #
          </div>
          <span className="text-text-faint">lunch-pool</span>
        </div>
        <div className="mx-1.5 px-3 py-2 rounded-md flex items-center gap-2.5 text-sm">
          <div className="w-6 h-6 rounded-md bg-bg-elevated text-text-dim flex items-center justify-center text-[10px] font-semibold">
            #
          </div>
          <span className="text-text-faint">ops-standup</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `Sidebar.tsx`**

```tsx
import { ChannelsPreview } from "./ChannelsPreview";
import { DmList } from "./DmList";
import { IdentityHeader } from "./IdentityHeader";
import type { Contact, ConversationLog, Identity } from "@/lib/types";

interface SidebarProps {
  identity: Identity;
  contacts: Contact[];
  conversations: ConversationLog[];
  selectedConnectionId: string | null;
  onSelect: (connectionId: string) => void;
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="w-60 bg-bg-rail border-r border-bg-border flex flex-col">
      <IdentityHeader identity={props.identity} />
      <div className="flex-1 overflow-y-auto py-2">
        <DmList
          contacts={props.contacts}
          conversations={props.conversations}
          selectedConnectionId={props.selectedConnectionId}
          onSelect={props.onSelect}
        />
        <ChannelsPreview />
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Verify typecheck and build**

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/components/rail
git commit -m "feat(ui): add sidebar components (identity, DMs, channels preview)"
```

---

## Task 9: Chat thread components

**Files:**
- Create: `packages/ui/components/chat/MessageBubble.tsx`
- Create: `packages/ui/components/chat/ActionCard.tsx`
- Create: `packages/ui/components/chat/Composer.tsx`
- Create: `packages/ui/components/chat/EmptyState.tsx`
- Create: `packages/ui/components/chat/Thread.tsx`

The main chat column. Renders a chronological mix of `MessageBubble`s and `ActionCard`s for the selected DM.

**Visual contract:** chat bubbles colored by direction, inline rich action cards with status badges and approve/deny buttons for pending items, read-only composer at the bottom. Refer to the spec's visual section.

- [ ] **Step 1: Create `MessageBubble.tsx`**

```tsx
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { formatInitials } from "@/lib/format";

interface MessageBubbleProps {
  text: string;
  timestamp: string;
  direction: "incoming" | "outgoing";
  authorInitials: string;
}

export function MessageBubble({ text, timestamp, direction, authorInitials }: MessageBubbleProps) {
  const outgoing = direction === "outgoing";
  return (
    <div className={cn("flex gap-2.5 max-w-[72%]", outgoing && "ml-auto flex-row-reverse")}>
      <Avatar
        initials={authorInitials}
        size="md"
        variant={outgoing ? "warm" : "primary"}
      />
      <div>
        <div
          className={cn(
            "px-3.5 py-2.5 rounded-bubble text-[13px] leading-snug",
            outgoing ? "bg-accent-primary/30 text-text" : "bg-bg-elevated text-text",
          )}
        >
          {text}
        </div>
        <div className="text-[10px] text-text-faint mt-1">{timestamp}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `ActionCard.tsx`**

```tsx
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { ActionKind } from "@/lib/types";
import { CalendarDays, DollarSign, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

interface ActionCardProps {
  kind: ActionKind;
  title: string;
  subtitle?: string;
  rows?: { label: string; value: string }[];
  status?: "pending" | "completed" | "failed";
  statusText?: string;
  outgoing?: boolean;
  onApprove?: () => void;
  onDeny?: () => void;
  children?: ReactNode;
}

const KIND_META: Record<ActionKind, { icon: ReactNode; label: string }> = {
  transfer: {
    icon: <DollarSign className="w-3.5 h-3.5" />,
    label: "Transfer request",
  },
  scheduling: {
    icon: <CalendarDays className="w-3.5 h-3.5" />,
    label: "Meeting proposal",
  },
  grant: {
    icon: <ShieldCheck className="w-3.5 h-3.5" />,
    label: "Grant request",
  },
};

const STATUS_STYLES: Record<NonNullable<ActionCardProps["status"]>, string> = {
  pending: "bg-amber-500/15 text-amber-300",
  completed: "bg-green-500/15 text-green-400",
  failed: "bg-red-500/15 text-red-400",
};

export function ActionCard({
  kind,
  title,
  subtitle,
  rows,
  status,
  statusText,
  outgoing,
  onApprove,
  onDeny,
  children,
}: ActionCardProps) {
  const meta = KIND_META[kind];
  return (
    <Card className={cn("max-w-[380px] p-3.5", outgoing ? "ml-auto mr-9" : "ml-9")}>
      <div className="text-[11px] uppercase tracking-wider text-text-muted flex items-center gap-2 mb-2">
        <span className="w-5.5 h-5.5 rounded-md bg-blue-500/20 text-blue-300 inline-flex items-center justify-center">
          {meta.icon}
        </span>
        {meta.label}
      </div>
      <div className="text-[15px] font-semibold mb-0.5">{title}</div>
      {subtitle && <div className="text-xs text-text-muted mb-3">{subtitle}</div>}
      {rows && rows.length > 0 && (
        <div className="space-y-1 mb-2">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between text-xs">
              <span className="text-text-dim">{row.label}</span>
              <span className="text-text font-mono text-[11px]">{row.value}</span>
            </div>
          ))}
        </div>
      )}
      {status && statusText && (
        <div className="mt-2.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-pill px-2 py-1 text-[11px] font-medium",
              STATUS_STYLES[status],
            )}
          >
            {statusText}
          </span>
        </div>
      )}
      {(onApprove || onDeny) && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-bg-divider">
          {onApprove && (
            <Button variant="primary" size="sm" className="flex-1" onClick={onApprove}>
              Approve
            </Button>
          )}
          {onDeny && (
            <Button variant="ghost" size="sm" className="flex-1" onClick={onDeny}>
              Decline
            </Button>
          )}
        </div>
      )}
      {children}
    </Card>
  );
}
```

- [ ] **Step 3: Create `Composer.tsx`**

```tsx
export function Composer() {
  return (
    <div className="border-t border-bg-border px-4 py-3">
      <div className="px-3.5 py-2.5 rounded-lg bg-bg-subtle text-text-faint text-[13px] italic border border-bg-input">
        Your agent speaks here — read-only in v1
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `EmptyState.tsx`**

```tsx
export function EmptyState() {
  return (
    <div className="h-full grid place-items-center text-text-dim">
      <div className="text-center">
        <div className="text-sm">Select a direct connection from the left</div>
        <div className="text-xs text-text-faint mt-1">Conversations appear here in real time</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `Thread.tsx`**

```tsx
"use client";

import { Avatar } from "@/components/ui/avatar";
import { useEffect, useRef } from "react";
import { formatChain, formatInitials, formatRelativeTime } from "@/lib/format";
import type { Contact, ConversationLog } from "@/lib/types";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

interface ThreadProps {
  contact: Contact;
  conversation: ConversationLog | null;
}

export function Thread({ contact, conversation }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation?.messages.length]);

  return (
    <div className="flex-1 flex flex-col bg-bg-main min-w-0">
      <header className="px-4.5 py-3 border-b border-bg-border flex items-center gap-3">
        <Avatar initials={formatInitials(contact.peerDisplayName)} size="lg" />
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{contact.peerDisplayName}</div>
          <div className="text-xs text-text-dim">agent #{contact.peerAgentId}</div>
        </div>
        <div className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-pill bg-blue-500/10 text-blue-300">
          {formatChain(contact.peerChain)}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4.5 py-4 space-y-3.5">
        {conversation && conversation.messages.length > 0 ? (
          conversation.messages.map((message, idx) => (
            <MessageBubble
              key={message.messageId ?? `${conversation.conversationId}-${idx}`}
              text={message.content}
              direction={message.direction}
              timestamp={formatRelativeTime(message.timestamp)}
              authorInitials={
                message.direction === "outgoing"
                  ? "ME"
                  : formatInitials(contact.peerDisplayName)
              }
            />
          ))
        ) : (
          <div className="text-center text-text-dim text-sm py-8">No messages yet</div>
        )}
      </div>

      <Composer />
    </div>
  );
}
```

- [ ] **Step 6: Add Tailwind arbitrary spacing class for `px-4.5` / `py-4.5`**

The default Tailwind doesn't have `4.5` spacing. Add it to `tailwind.config.ts` extend.spacing:

```ts
extend: {
  spacing: {
    "4.5": "1.125rem",
    "5.5": "1.375rem",
  },
  // ... existing extend props
}
```

- [ ] **Step 7: Verify typecheck and build**

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/components/chat packages/ui/tailwind.config.ts
git commit -m "feat(ui): add chat thread components (bubbles, action cards, composer, empty state)"
```

---

## Task 10: Main page wiring with SWR + SSE

**Files:**
- Modify: `packages/ui/app/page.tsx`

This is where everything comes together: SWR fetches, SSE subscription pushes updates into the cache, search-param-driven thread selection.

- [ ] **Step 1: Replace `app/page.tsx` with the wired version**

```tsx
"use client";

import { Sidebar } from "@/components/rail/Sidebar";
import { ActionCard } from "@/components/chat/ActionCard";
import { EmptyState } from "@/components/chat/EmptyState";
import { Thread } from "@/components/chat/Thread";
import { TapdClient } from "@/lib/api";
import { EventStream } from "@/lib/events";
import { captureToken, getToken } from "@/lib/token";
import type { Contact, ConversationLog, Identity, PendingItem, TapEvent } from "@/lib/types";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";

const TAPD_BASE_URL =
  typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:6810";

const client = new TapdClient(TAPD_BASE_URL);

const fetchers = {
  identity: () => client.getIdentity(),
  contacts: () => client.listContacts(),
  conversations: () => client.listConversations(),
  pending: () => client.listPending(),
};

export default function HomePage() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

  // Capture the bearer token from the URL hash on first load.
  useEffect(() => {
    captureToken();
    setBootstrapped(true);
  }, []);

  if (!bootstrapped) {
    return null;
  }

  const tokenAvailable = !!getToken();
  if (!tokenAvailable) {
    return (
      <div className="h-screen grid place-items-center text-text-dim">
        <div className="text-center max-w-md">
          <div className="text-sm">Open this dashboard via <code className="bg-bg-elevated px-1.5 py-0.5 rounded font-mono text-xs">tap ui</code></div>
          <div className="text-xs text-text-faint mt-2">No bearer token in URL hash</div>
        </div>
      </div>
    );
  }

  return <Dashboard selectedConnectionId={selectedConnectionId} setSelectedConnectionId={setSelectedConnectionId} />;
}

function Dashboard({
  selectedConnectionId,
  setSelectedConnectionId,
}: {
  selectedConnectionId: string | null;
  setSelectedConnectionId: (id: string | null) => void;
}) {
  const { mutate } = useSWRConfig();
  const { data: identity } = useSWR<Identity>("identity", fetchers.identity);
  const { data: contacts } = useSWR<Contact[]>("contacts", fetchers.contacts);
  const { data: conversations } = useSWR<ConversationLog[]>("conversations", fetchers.conversations);
  const { data: pending } = useSWR<PendingItem[]>("pending", fetchers.pending);

  // Subscribe to live events. Mutate the SWR cache on every event so the UI updates
  // without a page refresh. Granular invalidation could be done per-event-type, but
  // for v1 the simple invalidate-on-event approach is fine.
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const handler = (event: TapEvent) => {
      switch (event.type) {
        case "message.received":
        case "message.sent":
        case "action.requested":
        case "action.completed":
        case "action.pending":
          mutate("conversations");
          mutate("pending");
          break;
        case "connection.established":
          mutate("contacts");
          mutate("conversations");
          break;
        case "daemon.status":
        default:
          break;
      }
    };
    const stream = new EventStream(TAPD_BASE_URL, token, handler);
    stream.start();
    return () => stream.stop();
  }, [mutate]);

  const selectedContact = useMemo(
    () => contacts?.find((c) => c.connectionId === selectedConnectionId) ?? null,
    [contacts, selectedConnectionId],
  );

  const selectedConversation = useMemo(
    () =>
      conversations?.find((c) => c.connectionId === selectedConnectionId) ?? null,
    [conversations, selectedConnectionId],
  );

  // Auto-select the first DM if none is selected.
  useEffect(() => {
    if (!selectedConnectionId && contacts && contacts.length > 0) {
      const firstActive = contacts.find((c) => c.status === "active");
      if (firstActive) {
        setSelectedConnectionId(firstActive.connectionId);
      }
    }
  }, [contacts, selectedConnectionId, setSelectedConnectionId]);

  // Mark the selected conversation as read whenever it changes.
  useEffect(() => {
    if (selectedConversation && (!selectedConversation.lastReadAt || selectedConversation.lastReadAt < selectedConversation.lastMessageAt)) {
      void client.markConversationRead(selectedConversation.conversationId).then(() => {
        mutate("conversations");
      });
    }
  }, [selectedConversation, mutate]);

  if (!identity) {
    return <div className="h-screen grid place-items-center text-text-dim">Loading…</div>;
  }

  const pendingForThread =
    pending?.filter(
      (p) =>
        selectedContact && p.peerAgentId === selectedContact.peerAgentId && p.method === "action/request",
    ) ?? [];

  return (
    <div className="h-screen flex bg-bg-DEFAULT text-text">
      <Sidebar
        identity={identity}
        contacts={contacts ?? []}
        conversations={conversations ?? []}
        selectedConnectionId={selectedConnectionId}
        onSelect={setSelectedConnectionId}
      />
      {selectedContact ? (
        <div className="flex-1 flex flex-col">
          <Thread contact={selectedContact} conversation={selectedConversation} />
          {pendingForThread.length > 0 && (
            <div className="px-4.5 pb-4 space-y-3 bg-bg-main">
              {pendingForThread.map((item) => (
                <ActionCard
                  key={item.requestId}
                  kind={(item.kind as "transfer" | "scheduling" | "grant") ?? "transfer"}
                  title="Awaiting your decision"
                  subtitle={`Request ${item.requestId}`}
                  status="pending"
                  statusText="awaiting you"
                  onApprove={async () => {
                    await client.approvePending(item.requestId);
                    mutate("pending");
                  }}
                  onDeny={async () => {
                    await client.denyPending(item.requestId);
                    mutate("pending");
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1">
          <EmptyState />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck and build**

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui build`
Expected: clean. The build should produce `packages/ui/out/index.html` plus a `_next` directory.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/app/page.tsx
git commit -m "feat(ui): wire main page with SWR fetching and SSE subscription"
```

---

## Task 11: tapd serves the static UI bundle

**Files:**
- Create: `packages/tapd/src/http/static-assets.ts`
- Create: `packages/tapd/test/unit/static-assets.test.ts`
- Modify: `packages/tapd/src/http/server.ts`
- Modify: `packages/tapd/src/daemon.ts`
- Modify: `packages/tapd/package.json` (add prebuild copy step)
- Modify: workspace root `package.json` (add `ui:build` to build chain)

The daemon needs to serve the UI's `out/` directory at `/`. We add a small static asset handler that's invoked before the route dispatcher.

- [ ] **Step 1: Write the failing static-assets test**

Create `packages/tapd/test/unit/static-assets.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStaticAsset } from "../../src/http/static-assets.js";

describe("resolveStaticAsset", () => {
  let assetsRoot: string;

  beforeEach(async () => {
    assetsRoot = await mkdtemp(join(tmpdir(), "tapd-assets-"));
    await writeFile(join(assetsRoot, "index.html"), "<html></html>");
    await mkdir(join(assetsRoot, "_next", "static", "css"), { recursive: true });
    await writeFile(join(assetsRoot, "_next", "static", "css", "app.css"), "body{}");
  });

  afterEach(async () => {
    await rm(assetsRoot, { recursive: true, force: true });
  });

  it("resolves the index when path is /", async () => {
    const result = await resolveStaticAsset(assetsRoot, "/");
    expect(result?.contentType).toBe("text/html; charset=utf-8");
    expect(result?.body.toString("utf-8")).toBe("<html></html>");
  });

  it("resolves nested asset paths", async () => {
    const result = await resolveStaticAsset(assetsRoot, "/_next/static/css/app.css");
    expect(result?.contentType).toBe("text/css; charset=utf-8");
  });

  it("returns null for non-existent files", async () => {
    const result = await resolveStaticAsset(assetsRoot, "/missing.html");
    expect(result).toBeNull();
  });

  it("rejects path traversal attempts", async () => {
    const result = await resolveStaticAsset(assetsRoot, "/../etc/passwd");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/static-assets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement static-assets**

Create `packages/tapd/src/http/static-assets.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

export interface StaticAsset {
  body: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

export async function resolveStaticAsset(
  rootDir: string,
  urlPath: string,
): Promise<StaticAsset | null> {
  const normalizedRoot = resolve(rootDir);
  const cleaned = normalize(urlPath === "/" ? "/index.html" : urlPath);
  const candidate = resolve(join(normalizedRoot, cleaned));

  if (!candidate.startsWith(normalizedRoot + sep) && candidate !== normalizedRoot) {
    return null;
  }

  let target = candidate;
  try {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      target = join(target, "index.html");
    }
    const body = await readFile(target);
    const contentType = CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    return { body, contentType };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run static-assets test, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/static-assets.test.ts`
Expected: all PASS.

- [ ] **Step 5: Wire static assets into the HTTP server**

Modify `packages/tapd/src/http/server.ts`. Add a `staticAssetsDir` option to `TapdHttpServerOptions`:

```ts
export interface TapdHttpServerOptions {
  router: Router;
  socketPath: string;
  tcpHost: string;
  tcpPort: number;
  authToken: string;
  sseHandler?: (req: IncomingMessage, res: ServerResponse, transport: "unix" | "tcp") => boolean;
  staticAssetsDir?: string;
}
```

Then modify `handleAsync` to attempt static asset resolution after auth and before route dispatch — but only for GET requests on paths that don't start with `/api/` or `/daemon/`:

```ts
private async handleAsync(
  req: IncomingMessage,
  res: ServerResponse,
  transport: "unix" | "tcp",
): Promise<void> {
  if (!authorizeRequest(req, { transport, expectedToken: this.authToken })) {
    sendUnauthorized(res);
    return;
  }

  if (this.sseHandler && this.sseHandler(req, res, transport)) {
    return;
  }

  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // Static asset serving for non-API GETs.
  if (
    method === "GET" &&
    this.staticAssetsDir &&
    !path.startsWith("/api/") &&
    !path.startsWith("/daemon/")
  ) {
    const asset = await resolveStaticAsset(this.staticAssetsDir, path);
    if (asset) {
      res.writeHead(200, {
        "Content-Type": asset.contentType,
        "Content-Length": asset.body.length,
        "Cache-Control": "no-store",
      });
      res.end(asset.body);
      return;
    }
  }

  let body: unknown;
  if (method !== "GET" && method !== "HEAD") {
    body = await readJsonBody(req);
  }

  const result = await this.router.dispatch(method, path, body);
  if (result === null) {
    sendNotFound(res);
    return;
  }
  sendJson(res, 200, result);
}
```

Add the import: `import { resolveStaticAsset } from "./static-assets.js";`

Save the staticAssetsDir option in the constructor:

```ts
private readonly staticAssetsDir?: string;
// ... in constructor:
this.staticAssetsDir = options.staticAssetsDir;
```

- [ ] **Step 6: Wire `staticAssetsDir` from `Daemon`**

Modify `packages/tapd/src/daemon.ts`. Add an optional `staticAssetsDir` to `DaemonOptions` and pass it to `TapdHttpServer`. The default resolution: `<tapd-package>/dist/ui` or, for development/tests, the value provided by the constructor.

```ts
export interface DaemonOptions {
  config: TapdConfig;
  identityAgentId: number;
  identitySource: IdentitySource;
  buildService: () => Promise<TapMessagingService>;
  trustStore: ITrustStore;
  conversationLogger: IConversationLogger;
  staticAssetsDir?: string;
}
```

In the constructor or `start()`, store the option and pass it through:

```ts
this.server = new TapdHttpServer({
  // ...existing options
  staticAssetsDir: this.options.staticAssetsDir,
});
```

- [ ] **Step 7: Wire it from `bin.ts`**

Modify `packages/tapd/src/bin.ts` to resolve the UI assets directory relative to the binary location:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ... in main():
const here = dirname(fileURLToPath(import.meta.url));
const staticAssetsDir = join(here, "ui");
```

And pass `staticAssetsDir` into the `Daemon` constructor.

- [ ] **Step 8: Add prebuild copy step to `packages/tapd/package.json`**

Add a `prebuild` script that copies `packages/ui/out/` into `packages/tapd/dist/ui/`:

```json
"scripts": {
  "prebuild": "rm -rf dist/ui && mkdir -p dist && cp -r ../ui/out dist/ui",
  "build": "tsc -p tsconfig.json && bun run prebuild",
  ...
}
```

Wait — the prebuild needs to happen **after** the TypeScript build (so `dist` exists), or we need to ensure `dist` is created. Reorder: TypeScript build creates dist, then we copy ui output into it. Use `postbuild` instead:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "postbuild": "rm -rf dist/ui && mkdir -p dist && (test -d ../ui/out && cp -r ../ui/out dist/ui || echo 'WARN: packages/ui/out not built yet, skipping ui copy')",
  ...
}
```

The `postbuild` runs after `build`. The conditional copy means tapd can still build before ui is built (useful during development).

- [ ] **Step 9: Update workspace root `package.json` build script**

Add a build script that builds in the right order: core → app-transfer → app-scheduling → sdk → tapd → ui → tapd (postbuild copies ui artifacts). Or simpler: just ensure ui builds before tapd's postbuild needs it.

The simplest fix is to add an explicit ordered build script in the root:

```json
"build": "bun run --cwd packages/core build && bun run --cwd packages/app-transfer build && bun run --cwd packages/app-scheduling build && bun run --cwd packages/sdk build && bun run --cwd packages/ui build && bun run --cwd packages/tapd build && bun run --cwd packages/cli build && bun run --cwd packages/openclaw-plugin build",
```

(Verify the existing build script and adjust accordingly — don't blindly overwrite.)

- [ ] **Step 10: Run repo build to verify**

Run: `bun run --cwd packages/ui build && bun run --cwd packages/tapd build && ls packages/tapd/dist/ui/index.html`
Expected: `index.html` exists in the tapd dist.

- [ ] **Step 11: Run all tapd tests**

Run: `bun run --cwd packages/tapd test`
Expected: all PASS, including the new static-assets test.

- [ ] **Step 12: Commit**

```bash
git add packages/tapd/src/http/static-assets.ts packages/tapd/test/unit/static-assets.test.ts packages/tapd/src/http/server.ts packages/tapd/src/daemon.ts packages/tapd/src/bin.ts packages/tapd/package.json package.json
git commit -m "feat(tapd): serve packages/ui static export from the daemon"
```

---

## Task 12: Playwright golden-path end-to-end test

**Files:**
- Create: `packages/ui/playwright.config.ts`
- Create: `packages/ui/test/e2e/golden-path.spec.ts`
- Create: `packages/ui/test/e2e/fixtures/seed-tapd.ts`

The most important test in Phase 2: spin up tapd against a temp data dir seeded with a contact and a conversation, build the UI, point Playwright at the running daemon, and click through the demo scenario. This is the regression gate for the demo.

- [ ] **Step 1: Add Playwright config**

Create `packages/ui/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "line",
  timeout: 30_000,
  use: {
    headless: true,
  },
});
```

- [ ] **Step 2: Install Playwright browsers**

Run: `bun run --cwd packages/ui exec playwright install chromium`

- [ ] **Step 3: Create the seed-tapd helper**

Create `packages/ui/test/e2e/fixtures/seed-tapd.ts`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface SeededTapd {
  dataDir: string;
  url: string;
  token: string;
  process: ChildProcess;
  cleanup: () => Promise<void>;
}

/**
 * Spawns a real tapd binary against a temp data dir seeded with one identity,
 * one active contact, and one conversation. Returns the URL and bearer token.
 *
 * Note: this requires that packages/tapd has been built (dist/bin.js exists).
 */
export async function seedTapd(): Promise<SeededTapd> {
  const dataDir = await mkdtemp(join(tmpdir(), "tapd-e2e-"));

  // Write a minimal config.yaml
  await writeFile(
    join(dataDir, "config.yaml"),
    `agent_id: 42
chain: eip155:8453
ows:
  wallet: "test-wallet"
  api_key: "test-key"
xmtp:
  db_encryption_key: "${"00".repeat(32)}"
`,
    "utf-8",
  );

  // Seed contacts.json with one active contact
  await writeFile(
    join(dataDir, "contacts.json"),
    JSON.stringify({
      contacts: [
        {
          connectionId: "conn-bob",
          peerAgentId: 108,
          peerChain: "eip155:8453",
          peerOwnerAddress: "0xbb00000000000000000000000000000000000000",
          peerDisplayName: "Bob",
          peerAgentAddress: "0xbb00000000000000000000000000000000000000",
          permissions: {
            grantedByMe: { version: "tap-grants/v1", updatedAt: new Date().toISOString(), grants: [] },
            grantedByPeer: { version: "tap-grants/v1", updatedAt: new Date().toISOString(), grants: [] },
          },
          establishedAt: "2026-04-01T00:00:00.000Z",
          lastContactAt: "2026-04-01T00:05:00.000Z",
          status: "active",
        },
      ],
    }),
    "utf-8",
  );

  // Seed an empty journal
  await writeFile(join(dataDir, "request-journal.json"), JSON.stringify({ entries: [] }), "utf-8");

  // Seed a conversation log with two messages
  await mkdir(join(dataDir, "conversations"), { recursive: true });
  await writeFile(
    join(dataDir, "conversations", "conv-bob.json"),
    JSON.stringify({
      conversationId: "conv-bob",
      connectionId: "conn-bob",
      peerAgentId: 108,
      peerDisplayName: "Bob",
      startedAt: "2026-04-01T00:00:00.000Z",
      lastMessageAt: "2026-04-01T00:05:00.000Z",
      status: "active",
      messages: [
        {
          messageId: "m1",
          timestamp: "2026-04-01T00:00:00.000Z",
          direction: "incoming",
          scope: "default",
          content: "Hey — thanks for connecting. My operator said you'd probably want to settle up for lunch.",
          humanApprovalRequired: false,
          humanApprovalGiven: null,
        },
        {
          messageId: "m2",
          timestamp: "2026-04-01T00:05:00.000Z",
          direction: "outgoing",
          scope: "default",
          content: "Sure thing — sending $10 now.",
          humanApprovalRequired: false,
          humanApprovalGiven: null,
        },
      ],
    }),
    "utf-8",
  );

  // Spawn tapd
  const binPath = join(__dirname, "..", "..", "..", "..", "tapd", "dist", "bin.js");
  const tapdProcess = spawn("node", [binPath], {
    env: {
      ...process.env,
      TAP_DATA_DIR: dataDir,
      TAPD_PORT: "0", // OS-assigned
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture stdout to extract the bound port
  let stdout = "";
  let stderr = "";
  tapdProcess.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  tapdProcess.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  // Wait for the daemon to be reachable. Read the token from the file once it exists.
  const tokenPath = join(dataDir, ".tapd-token");
  let token = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const fs = await import("node:fs/promises");
      token = (await fs.readFile(tokenPath, "utf-8")).trim();
      if (token) break;
    } catch {
      // Not yet.
    }
  }
  if (!token) {
    tapdProcess.kill();
    throw new Error(`tapd never wrote a token file. stdout=${stdout} stderr=${stderr}`);
  }

  // Probe the daemon for its bound port via the unix socket — actually, we need TCP for the browser.
  // Tapd writes its bound port to stdout in the form "tapd ... port=NNNN". Parse it.
  const portMatch = stdout.match(/port=(\d+)/);
  if (!portMatch) {
    // Wait briefly and retry
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const portMatch2 = stdout.match(/port=(\d+)/);
  // Note: port=0 in startup line means OS-assigned; we need a different mechanism.
  // Easiest: have tapd write its bound port to a file `<dataDir>/.tapd.port`.

  // For now, query the unix socket to discover the actual TCP port.
  // OR: extend bin.ts to write the bound TCP port to <dataDir>/.tapd.port.
  // For the Playwright test, the simplest path is the latter.

  let port = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const fs = await import("node:fs/promises");
      const portStr = await fs.readFile(join(dataDir, ".tapd.port"), "utf-8");
      port = Number.parseInt(portStr.trim(), 10);
      if (port > 0) break;
    } catch {
      // Not yet
    }
  }
  if (!port) {
    tapdProcess.kill();
    throw new Error(`tapd never wrote a port file. stdout=${stdout} stderr=${stderr}`);
  }

  return {
    dataDir,
    url: `http://127.0.0.1:${port}`,
    token,
    process: tapdProcess,
    cleanup: async () => {
      tapdProcess.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
```

Note: this fixture **requires tapd to write its bound TCP port to `<dataDir>/.tapd.port`**. This is a small but mandatory tapd modification. Add it to `bin.ts` and `daemon.ts` as part of this task — see Step 4.

- [ ] **Step 4: Make tapd write its bound port file**

Modify `packages/tapd/src/bin.ts` after `daemon.runUntilSignal()` has been called to write `<dataDir>/.tapd.port`. Actually, better: do this in `Daemon.start()` after the server has bound, so the file appears as soon as the daemon is reachable.

In `packages/tapd/src/daemon.ts`, after `await this.server.start();`:

```ts
const port = this.server.boundTcpPort();
await writeFile(join(this.options.config.dataDir, ".tapd.port"), String(port), {
  encoding: "utf-8",
  mode: 0o600,
});
```

Add the import: `import { writeFile } from "node:fs/promises";` and `import { join } from "node:path";`.

Also clean up the port file on `stop()`:

```ts
await rm(join(this.options.config.dataDir, ".tapd.port"), { force: true }).catch(() => {});
```

Test it lightly — add an assertion to the lifecycle integration test that `.tapd.port` exists after start.

The `bin.ts` does NOT need to change because the daemon class handles this.

The `loadTrustedAgentConfigFromDataDir` in bin.ts requires a real OWS wallet for actual signing operations — but for the e2e test, the daemon will start without ever signing anything, because we only hit the read endpoints and there's no transport activity. Verify this works by running the e2e fixture by hand once.

If `OwsSigningProvider` construction fails because of the fake wallet, you may need to add a `--no-transport` mode to `bin.ts` that constructs the daemon without an OWS signer or real transport. This is a v2 concern; for the Playwright test, the simplest path is to construct the daemon programmatically in the test rather than spawn the bin.

**Recommendation:** rewrite `seedTapd` to start the daemon **in-process** rather than spawning a subprocess. That way you have full control over the construction and don't need to worry about OWS wallets or process spawning. Use a fake `TapMessagingService` like the daemon lifecycle test does.

Replace the spawn-based implementation with an in-process one:

```ts
import { Daemon, type DaemonOptions } from "trusted-agents-tapd/dist/daemon.js";
// ... etc
```

Look at `packages/tapd/test/integration/lifecycle.test.ts` and `http-end-to-end.test.ts` for the pattern. Build a minimal Daemon with stub stores and a fake service, start it, and have it serve the static assets directory.

This is significantly simpler and avoids all the subprocess/file-watching issues.

- [ ] **Step 5: Replace `seedTapd` with an in-process Daemon**

Rewrite `packages/ui/test/e2e/fixtures/seed-tapd.ts` to construct a `Daemon` in-process, just like the existing tapd integration tests do. The Playwright test then opens `http://127.0.0.1:<port>/?token=<token>` and clicks through the UI.

Refer to `packages/tapd/test/integration/http-end-to-end.test.ts` for the exact pattern. The fake services should:
- Return a populated identity (Alice, agentId=42, base chain)
- Return one active contact (Bob)
- Return one conversation with two messages
- Return zero pending items initially
- Return null for unknown operations

The fake `TapMessagingService.getStatus()` should return `{ running: true, lock: null, pendingRequests: [] }`.

The `Daemon` constructor should be passed `staticAssetsDir: path.resolve(__dirname, "..", "..", "..", "out")` so it serves the freshly-built UI.

- [ ] **Step 6: Write the golden-path Playwright test**

Create `packages/ui/test/e2e/golden-path.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import { seedTapd, type SeededTapd } from "./fixtures/seed-tapd";

let tapd: SeededTapd;

test.beforeAll(async () => {
  tapd = await seedTapd();
});

test.afterAll(async () => {
  await tapd?.cleanup();
});

test("loads identity and shows the seeded contact in the sidebar", async ({ page }) => {
  await page.goto(`${tapd.url}/#token=${tapd.token}`);
  await expect(page.getByText("Bob")).toBeVisible();
  await expect(page.getByText("Alice")).toBeVisible();
});

test("clicking a contact opens the thread with seeded messages", async ({ page }) => {
  await page.goto(`${tapd.url}/#token=${tapd.token}`);
  await page.getByText("Bob").click();
  await expect(page.getByText(/lunch/)).toBeVisible();
  await expect(page.getByText(/sending \$10 now/)).toBeVisible();
});

test("composer is read-only and shows placeholder text", async ({ page }) => {
  await page.goto(`${tapd.url}/#token=${tapd.token}`);
  await page.getByText("Bob").click();
  await expect(page.getByText(/Your agent speaks here/)).toBeVisible();
});
```

- [ ] **Step 7: Run the Playwright test**

Run: `cd packages/ui && bun run build && bun run test:e2e`
Expected: all 3 tests PASS.

If `seedTapd` is doing the in-process approach, the test should be fast (< 5 seconds total).

- [ ] **Step 8: Commit**

```bash
git add packages/ui/playwright.config.ts packages/ui/test/e2e packages/tapd/src/daemon.ts
git commit -m "test(ui): add Playwright golden-path test against in-process tapd"
```

---

## Task 13: Final Phase 2 verification

- [ ] **Step 1: Build everything**

Run: `bun run --cwd packages/ui build && bun run --cwd packages/tapd build`
Expected: clean. `packages/tapd/dist/ui/index.html` exists.

- [ ] **Step 2: Run all UI tests**

Run: `bun run --cwd packages/ui test`
Expected: all unit tests PASS.

- [ ] **Step 3: Run all tapd tests**

Run: `bun run --cwd packages/tapd test`
Expected: all PASS, including the static-assets test.

- [ ] **Step 4: Run repo lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 5: Run full repo test suite**

Run: `bun run test`
Expected: all PASS (no regressions in core/cli/openclaw-plugin from Phase 2 changes).

- [ ] **Step 6: Run Playwright golden-path test**

Run: `bun run --cwd packages/ui test:e2e`
Expected: all 3 tests PASS.

- [ ] **Step 7: Inventory the new package**

Run: `find packages/ui/{app,components,lib} -name "*.tsx" -o -name "*.ts" | xargs wc -l | sort -n -r | head -20`
Expected: no source file > ~250 lines. Components are focused.

- [ ] **Step 8: Manual smoke check (optional but recommended)**

Run a real tapd against the freshly-built UI and click through it visually. If there's no real data, seed it via the same in-process fixture and open Chrome by hand.

- [ ] **Step 9: Final commit if anything is outstanding**

```bash
git add -A
git commit -m "chore(ui): final phase 2 cleanup"
```

**Phase 2 complete.** The web UI builds, talks to tapd, renders the chat metaphor, and the Playwright golden path passes. The next thing to plan is Phase 3: refactoring the CLI commands to be tapd HTTP clients.
