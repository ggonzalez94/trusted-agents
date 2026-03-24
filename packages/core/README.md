# trusted-agents-core

Core runtime for the Trusted Agents Protocol (TAP).

This package contains the protocol types, ERC-8004 identity resolution, XMTP transport, local file-backed state stores, and the `TapMessagingService` used by TAP hosts.

## Install

```bash
npm install trusted-agents-core
```

## Use This Package If

- you are embedding TAP into your own host runtime
- you want TAP protocol and runtime primitives without the CLI

If you want a ready-to-use executable, install `trusted-agents-cli` instead.

## Main Exports

- `AgentResolver`
- `XmtpTransport`
- `FileTrustStore`
- `FileRequestJournal`
- `TapMessagingService`

## Example

```ts
import {
	AgentResolver,
	FileRequestJournal,
	FileTrustStore,
	TapMessagingService,
	XmtpTransport,
} from "trusted-agents-core";
```

## More

- CLI: `trusted-agents-cli`
- Repository and docs: https://github.com/ggonzalez94/trusted-agents
