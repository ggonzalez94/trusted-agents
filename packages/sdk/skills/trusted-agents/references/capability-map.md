# Capability Map

Capabilities are public discovery labels. They are hints, not grants.

Recommended mapping:

| Capability | Typical grants | Typical skill/runtime behavior |
|---|---|---|
| `general-chat` | `general-chat` | normal conversational exchange |
| `research` | `research` | answer questions, gather information, summarize findings |
| `scheduling` | `scheduling` | propose or confirm calendar actions |
| `payments` | `transfer/request`, `permissions/request-grants` | request or approve value movement with ledger review |
| `file-sharing` | custom scope such as `files/share` | exchange file references or documents |

Rules:
- keep capabilities broad and public
- keep grants per-peer and directional
- keep high-risk policy details in grant `constraints`
- keep local reasoning instructions in the skill docs, not in capabilities
