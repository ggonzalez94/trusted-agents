# Handling SUMMARY Notification from ResearchBot

The notification type is **SUMMARY** ("Received message from ResearchBot"), not an ESCALATION. Per the skill instructions, the pattern for SUMMARY messages is: notification -> read underlying content -> act if I can -> message the user. Here are the exact steps:

## Step 1: Read the actual conversation content

Run the read-only CLI commands to get the full message context:

```bash
tap conversations list --with ResearchBot
```

This returns the conversation ID(s) with ResearchBot. Then, using the conversation ID from the output:

```bash
tap conversations show <conversation-id>
```

This gives the full conversation transcript so I can see ResearchBot's message in context and confirm what they said.

## Step 2: Respond automatically to ResearchBot via tap_gateway

ResearchBot has a `general-chat` grant, meaning they are permitted to exchange conversational messages with me. Their message is a clear, unambiguous research update with a specific follow-up question ("Want me to dig deeper into their pricing strategy?"). This is something I can answer -- it is a straightforward yes/no about continuing research that was already requested. I respond affirmatively:

```
tap_gateway send_message peer="ResearchBot" text="Thanks for the update -- that's a significant finding about competitor X's 15% price undercut. Yes, please dig deeper into their pricing strategy. Specifically, I'd like to understand whether this is a temporary promotional move or a permanent repositioning, and what margins they might be operating on." scope="general-chat"
```

## Step 3: Message the user to inform them

After responding to ResearchBot, I must message the user through the normal conversation channel (i.e., reply in the OpenClaw Gateway chat) to let them know what happened. The message to the user would be:

> ResearchBot sent a message: they completed the market analysis you requested. The key finding is that competitor X launched a new product last week that undercuts your pricing by 15%. They asked whether to dig deeper into competitor X's pricing strategy.
>
> I replied to ResearchBot and asked them to go ahead and investigate further -- specifically whether the price undercut is a temporary promotion or a permanent repositioning, and what margins competitor X might be operating on.
>
> Let me know if you'd like me to redirect their research focus or ask them anything else.

## Why this approach

- **Act before asking**: The skill's Action-First Rule and SUMMARY handling instructions say to act if I can, and only ask the user when I genuinely need their input. The message from ResearchBot is unambiguous -- it's a status update and a clear yes/no follow-up question about continuing work that was already commissioned.
- **Use tap_gateway, not CLI**: The skill specifies that in OpenClaw plugin mode with a healthy plugin, I must use `tap_gateway send_message` for sending messages rather than `tap message send`.
- **Read-only CLI is safe**: `tap conversations list` and `tap conversations show` are explicitly listed as safe read-only commands that can run alongside the plugin.
- **Always message the user**: The skill is emphatic that I must never process a notification silently. Even though I handled the reply automatically, I must inform the user what was said and how I responded.
- **Scope matches grant**: ResearchBot has a `general-chat` grant, and I send the reply with `scope="general-chat"` to match.
