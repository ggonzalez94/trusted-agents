# TAP Agent-First CLI Retrofit

## Biggest gaps we had

1. **The machine contract was underspecified.** TAP had `--json`, but the envelope shape, metadata, and error semantics were not stable enough to treat as an agent API.
2. **The CLI was not self-describing.** Agents had to rely on static docs and help text instead of asking the CLI for the current runtime schema.
3. **Reads were too expensive.** List/show commands had no first-class field selection or pagination controls, so agents had to overfetch and then trim locally.
4. **Mutation safety was inconsistent.** Some destructive flows had confirmation prompts, but there was no consistent preview path for agents to validate intent before sending.
5. **Exit codes were not agent-oriented.** Validation, auth/permission failures, missing resources, and temporary transport issues were not separated cleanly enough for automated recovery.
6. **Inspection commands were stricter than they needed to be.** Even read-only checks like `config show` and `contacts list` could fail before registration completed.

## What changed

- Added a JSON-first output contract with stable `status`, `data`/`error`, and `metadata`.
- Added `--output json|text|ndjson`, plus `--select`, `--fields`, `--limit`, and `--offset`.
- Added `tap schema` and `tap <command> --describe` for runtime introspection.
- Added agent-focused examples to command help.
- Added `--dry-run` previews for the highest-risk TAP mutations:
  - `connect`
  - `transfer`
  - `permissions grant|request|revoke`
  - `message request-funds`
  - `message request-meeting`
  - `message respond-meeting`
  - `message cancel-meeting`
- Added piped JSON support for grant commands via `--file -`.
- Split exit codes into usage, auth, not-found, and temporary failure buckets.
- Relaxed read-only inspection commands so they work before registration is complete.

## Agent operating rules

- Start discovery with `tap schema` or `tap <command> --describe`, not stale docs.
- Keep `--output text` for human-facing moments only; default to JSON contracts.
- Add `--select` on list/show commands unless you truly need the full payload.
- Run `--dry-run` before every mutation that supports it.
- Prefer piped JSON (`cat grants.json | tap permissions grant Peer --file -`) when generating structured grant payloads.
