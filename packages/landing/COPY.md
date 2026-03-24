# TAP Landing Page Copy

All copy for the Trusted Agents Protocol landing page, organized by section.

---

## 1. Hero

**Headline:**
Your agent. Their agent. Connected.

**Subline:**
A local-first protocol for AI agents to discover, trust, and transact — on behalf of the humans who own them.

**CTA Primary:** Get Started
**CTA Secondary:** View on GitHub

---

## 2. Problem

**Headline:**
Your agents are isolated.

**Body:**
You run an AI agent. Your friend runs one too. Today there is no standard way for them to find each other, verify identity, and collaborate securely. No shared directory. No trust layer. No protocol.

TAP fixes this.

---

## 3. How It Works

### Step 1: Register on-chain

**Headline:** Claim your identity

**Description:**
Your agent mints an ERC-8004 NFT — a verifiable on-chain identity that points to its public profile, capabilities, and endpoint. Costs about $0.50 in USDC.

```
tap register --name "MyAgent" --description "Personal assistant" --capabilities "general-chat,transfer"
```

### Step 2: Share an invite

**Headline:** Send a signed link

**Description:**
Generate a cryptographically signed invite and share it over any channel — text, email, QR code, in person. No centralized directory. No discovery service. Just a link between two people who already know each other.

```
tap invite create
```

### Step 3: Connect with trust

**Headline:** Verify and handshake

**Description:**
The receiving agent verifies the invite signature, resolves the sender's on-chain identity, and asks its owner for approval. Both agents store the trust relationship locally. Every future message is authenticated.

```
tap connect "<invite-url>" --yes
```

### Step 4: Message and transact

**Headline:** Collaborate with permissions

**Description:**
Connected agents communicate over encrypted XMTP messaging using JSON-RPC. Owners control exactly what each peer can do through directional permission grants — scoped by action, amount, and time window.

```
tap message send PeerAgent "What's on the agenda today?"
```

---

## 4. Use Cases

### Card 1: Split expenses

**Title:** Split expenses between roommates

**Description:**
Your agent tracks shared costs and settles up with your roommate's agent automatically. Scoped grants mean each agent can only request what you've approved — no surprises, no overspending.

### Card 2: Freelancer billing

**Title:** Freelancer bills client on delivery

**Description:**
A freelancer's agent submits invoices directly to the client's agent with a scoped transfer grant. The client's agent pays within the approved budget. No invoicing tools, no payment reminders — just agents settling the tab.

### Card 3: Family coordination

**Title:** Family agents coordinate daily life

**Description:**
Your agent books a restaurant, checks your partner's agent for schedule conflicts, and confirms the reservation. Connected agents handle the back-and-forth so you don't have to.

---

## 5. Trust Model

**Headline:**
Contacts list, not marketplace.

**Body:**
TAP is not a discovery platform where strangers browse agent listings. It's a contacts list — built for personal trust between people who already know each other, mediated through their agents.

You control who your agent connects to. Every connection starts with a signed invite from someone you know. Permissions are directional — you decide exactly what each peer can ask for. All conversations are logged locally and reviewable by you at any time.

Your agent, your rules.

---

## 6. Tech Stack

| Badge | One-liner |
|---|---|
| **ERC-8004** | On-chain agent identity as NFT |
| **XMTP** | End-to-end encrypted agent messaging |
| **JSON-RPC 2.0** | Standard protocol wire format |
| **Account Abstraction** | Pay for everything with just USDC |
| **Open Source** | MIT licensed, forkable, auditable |

---

## 7. Get Started

**Headline:**
Start in under a minute.

**Intro:**
Two paths to get your agent on the network. Pick whichever fits your setup.

### Agent Mode

**Subhead:** Copy-paste this to your AI agent:

**Prompt text:**
> Read the TAP skill at https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/skills/trusted-agents/SKILL.md and then follow it to install TAP and set me up.

**Note:**
The skill walks your agent through installation, identity creation, funding, and registration — one step at a time.

If your agent already has the TAP skill installed (via `tap install`), just say:

> Install Trusted Agents Protocol from github.com/ggonzalez94/trusted-agents and set me up.

### Manual Mode

**Subhead:** Four commands to get on the network:

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash

# 2. Initialize
tap init --chain base

# 3. Fund (~$0.50 USDC on Base)
tap balance

# 4. Register
tap register --name "MyAgent" --description "Personal assistant" --capabilities "general-chat,transfer"
```

---

## 8. Footer

**Tagline:**
Trust starts with a connection.

**Links:** GitHub | MIT License | Documentation
