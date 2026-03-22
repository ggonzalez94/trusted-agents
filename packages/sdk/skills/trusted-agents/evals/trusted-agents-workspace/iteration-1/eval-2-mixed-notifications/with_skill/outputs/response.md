# Handling TAP Notifications

TAP notifications are in my context, so I act on them **before other work**. I process each one in order.

---

## 1. ESCALATION: Connection request from agent #42

This is an escalation, which means it needs the user's decision. I cannot approve or reject it on my own.

**Step 1 — Resolve the requesting agent's identity to understand who is asking:**

```bash
tap identity resolve 42
```

This returns the agent's name, description, capabilities, and chain so I can give the user meaningful context.

**Step 2 — List pending requests to get the `requestId`:**

```
tap_gateway list_pending
```

This returns the pending connection request entry with its `requestId`.

**Step 3 — Message the user with a clear summary:**

I send the user a message through our conversation channel (not just process it silently) explaining:

- Agent #42 wants to connect
- Their name, description, and capabilities (from the resolve output)
- Ask the user whether to accept or reject

For example: "Agent #42 ('WorkerBot' - a task execution agent with capabilities: transfer, general-chat) is requesting to connect with you. Should I accept or reject this connection request?"

**Step 4 — Wait for the user's decision.**

**Step 5 — Once the user decides, resolve the pending request:**

If approved:
```
tap_gateway resolve_pending requestId="<requestId from list_pending>" approve=true
```

If rejected:
```
tap_gateway resolve_pending requestId="<requestId from list_pending>" approve=false
```

---

## 2. SUMMARY: Approved 2.5 USDC transfer to WorkerBot (covered by grant)

This is a summary of an auto-approved transfer. The system already executed it because a matching grant existed. My job is to inform the user for visibility.

**Step 1 — Message the user with the transfer details:**

I send the user a message through our conversation channel: "A transfer of 2.5 USDC to WorkerBot was automatically approved and executed. This was covered by an existing grant."

No further action is needed since the transfer was already processed. The user just needs to know it happened.

---

## 3. INFO: Connection confirmed with AnalyticsBot

This is informational. The connection handshake with AnalyticsBot completed successfully -- both sides now have an active contact.

**Step 1 — Message the user so they know:**

I send the user a message through our conversation channel: "Connection with AnalyticsBot is now confirmed and active."

**Step 2 (optional follow-up) — If appropriate, consider next steps:**

Now that the connection is active, if the user has previously mentioned wanting to set up permissions with AnalyticsBot, I could proactively mention: "Would you like to set up any grants for AnalyticsBot? For example, a general-chat grant so you can exchange messages."

But I do not take any grant or permission action without the user's direction.
