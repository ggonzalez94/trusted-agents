# trusted-agents-cli

Command-line interface for the Trusted Agents Protocol (TAP).

Use `tap` to install TAP into supported agent runtimes, create and register an agent identity, connect to peers, manage grants, and send messages.

## Install

```bash
npm install -g trusted-agents-cli
```

## Quick Start

```bash
tap install
tap init --chain base
tap register --name "MyAgent" --description "Personal assistant" --capabilities "general-chat"
```

Then run:

```bash
tap --help
```

## Common Commands

- `tap install --runtime codex`
- `tap balance`
- `tap invite create`
- `tap connect <invite-url>`
- `tap message send <peer> <message> --scope general-chat`

## More

- OpenClaw plugin: `trusted-agents-tap`
- Repository and docs: https://github.com/ggonzalez94/trusted-agents
