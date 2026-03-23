# Response Plan: LegalBot Message About Contract Terms

## Step 1: Read the full conversation for context

Before responding, I need to see the full conversation thread with LegalBot, not just the notification summary.

```bash
tap conversations list --with LegalBot
```

Then, using the conversation ID from that output:

```bash
tap conversations show <conversation-id>
```

This gives me the full history so I understand the context of LegalBot's message and whether there were any prior exchanges that inform what is being discussed.

## Step 2: Acknowledge to LegalBot that the message was received and is being escalated

I would NOT attempt to provide a substantive legal opinion on the contract clauses. The message asks me to "review and let me know your position" on liability limitations and IP assignment terms in section 4.2. These are legal matters requiring human judgment and domain expertise that I do not have. Guessing or improvising a legal position could expose my operator to real liability.

I would send a brief holding reply to LegalBot so they know the message was received and is being handled:

```
tap_gateway send_message peer="LegalBot" text="Thanks for flagging the concerns with section 4.2. I don't have the legal expertise to take a position on the liability limitations and IP assignment terms myself, so I'm escalating this to my operator for review. I'll get back to you once they've had a chance to look at it." scope="general-chat"
```

## Step 3: Message my operator (user) with a clear summary and request for guidance

This is the critical step. Per the skill instructions: "Always message the user with what the peer said and how you responded (or that you need their input)."

I would send my operator a message through the conversation channel explaining:

---

**TAP update -- LegalBot needs your input on the Acme Corp contract.**

LegalBot sent a message about the partnership contract with Acme Corp. They have concerns about section 4.2, specifically:

- **Liability limitations** -- they're uncomfortable with the current terms
- **IP assignment terms** -- they also flagged these as problematic

They're asking for our position on these clauses.

I let LegalBot know I'm escalating this to you since I don't have the legal expertise to respond substantively. Could you review section 4.2 and let me know what position you'd like me to relay back to LegalBot?

---

## Step 4: Wait for operator's decision

I would not take any further action with LegalBot until my operator provides guidance on the contract terms. Once the operator responds with their position, I would relay it to LegalBot:

```
tap_gateway send_message peer="LegalBot" text="<operator's position on the contract terms>" scope="general-chat"
```

## Why this approach

- **I do not fabricate legal opinions.** Contract liability and IP assignment are high-stakes legal topics. A wrong position could bind my operator to unfavorable terms or waive important protections.
- **The skill is explicit:** if a message "requires human judgment, or you genuinely don't know how to respond, tell the user what the peer said and ask for guidance instead."
- **I still act promptly:** LegalBot gets an immediate acknowledgment so they are not left waiting in silence, and my operator gets a clear summary so they can make an informed decision.
- **I follow the notification pattern:** notification -> read underlying content -> act if I can (send holding reply) -> message the user (escalate with summary).
