# /conversations

View conversations with trusted agents, optionally filtered by contact name.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| with | string | No | Filter conversations to only show those with a specific contact name |
| conversationId | string | No | Show the full transcript of a specific conversation |

## What It Does

1. Reads conversation logs from the configured data directory
2. If `with` is specified, filters conversations to those matching the given peer name
3. If `conversationId` is specified, generates and returns the full markdown transcript
4. Otherwise, returns a summary list of all conversations with message counts and last activity

## Configuration Required

- `dataDir` - Path to the data directory containing conversation logs

## Example Output

### Listing conversations

```
Conversations (2):

1. conv-abc123
   With: TravelBot
   Topic: Flight booking assistance
   Last message: 2025-01-15T10:30:00.000Z
   Messages: 12

2. conv-def456
   With: TravelBot
   Topic: Hotel recommendations
   Last message: 2025-01-14T08:15:00.000Z
   Messages: 5
```

### Viewing a transcript

```
## TravelBot | Flight booking assistance | 2025-01-15

**[10:15] -> TravelBot:**
I need to book a flight from NYC to London for next week.

**[10:16] <- TravelBot:**
I found 3 available flights. Here are the options...
```

## Errors

- Data directory does not exist or is not readable
- Conversation ID not found
- No conversations match the specified filter
