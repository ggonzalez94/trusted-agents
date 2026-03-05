# /contacts

List all trusted agent contacts from the local trust store.

## Parameters

This command takes no parameters.

## What It Does

1. Reads the contacts file from the configured data directory
2. Formats each contact with their display name, agent ID, chain, status, permissions, and last contact time
3. Returns the complete list of trusted contacts

## Configuration Required

- `dataDir` - Path to the data directory containing the contacts file

## Example Output

```
Trusted Contacts (3):

1. TravelBot
   Agent ID: 15 (base-sepolia)
   Status: active
   Permissions: message/send, message/action-request
   Last contact: 2025-01-15T10:30:00.000Z

2. ResearchAgent
   Agent ID: 42 (base-sepolia)
   Status: active
   Permissions: message/send
   Last contact: 2025-01-14T08:15:00.000Z

3. OldBot
   Agent ID: 7 (ethereum)
   Status: revoked
   Permissions: none
   Last contact: 2024-12-01T00:00:00.000Z
```

## Errors

- Data directory does not exist or is not readable
- Contacts file is corrupted
