# Mobile Output Fetch Guide

This backend stores terminal output as ordered chunks under a session.

For a mobile app, the read path is:

1. Create or obtain a `sessionId`
2. Join the session if you want the user associated with it
3. Poll `GET /sessions/:id/output`
4. Merge chunks by `chunkId` on the client

## Base URL

- Local: `http://localhost:3000`
- Production: `https://<your-vercel-project>.vercel.app`

## Output model

Each output item returned by the API has this shape:

```json
{
  "chunkId": "c2fd4a8e-7db9-4ca8-8f2a-d7f6f2e01d88",
  "text": "Running tests...\n",
  "stream": "stdout",
  "createdAt": {
    "_seconds": 1712412345,
    "_nanoseconds": 123000000
  }
}
```

Fields:

- `chunkId`: unique ID for the output chunk
- `text`: terminal text for this chunk
- `stream`: either `stdout` or `stderr`
- `createdAt`: Firestore timestamp object

## Fetch output

Endpoint:

```http
GET /sessions/:sessionId/output?limit=200
```

Example:

```bash
curl "http://localhost:3000/sessions/SESSION_ID/output?limit=200"
```

Response:

```json
{
  "chunks": [
    {
      "chunkId": "3fd01a25-6e1e-4ec4-b4cf-7c716aa9b0b2",
      "text": "Starting agent...\n",
      "stream": "stdout",
      "createdAt": {
        "_seconds": 1712412345,
        "_nanoseconds": 0
      }
    },
    {
      "chunkId": "c0600b42-f39e-4068-98f2-d9bc59d96d75",
      "text": "Missing env var\n",
      "stream": "stderr",
      "createdAt": {
        "_seconds": 1712412350,
        "_nanoseconds": 0
      }
    }
  ]
}
```

Behavior:

- Results are ordered by `createdAt` ascending
- `limit` defaults to `200`
- `limit` max is `1000`
- If the session does not exist, the API returns `404`
- If the session is expired, the API returns `404` with code `SESSION_EXPIRED`

## Recommended mobile strategy

The current API does not expose `since`, `after`, or cursor-based pagination.
Because of that, the safest client pattern is polling plus client-side deduplication.

Recommended approach:

1. Poll every `2-5s` while the session screen is open
2. Request `GET /sessions/:id/output?limit=200`
3. Keep a local set/map keyed by `chunkId`
4. Append only chunks you have not seen yet
5. Render chunks in the response order

If a session may produce more than `200` chunks, increase the limit up to `1000`.

## Recommended companion calls

Use these endpoints with output polling:

### Create session

```http
POST /sessions
Content-Type: application/json
```

```json
{
  "agent": "codex",
  "name": "Fix login screen"
}
```

Response:

```json
{
  "sessionId": "SESSION_ID"
}
```

### Join session

```http
POST /sessions/:sessionId/join
Content-Type: application/json
```

```json
{
  "userId": "firebase-user-id",
  "customName": "Simon"
}
```

### Read session list for a user

```http
GET /users/:userId/sessions
```

This is useful if the mobile app shows recent or active sessions.

## React Native example

```ts
type OutputChunk = {
  chunkId: string;
  text: string;
  stream: "stdout" | "stderr";
  createdAt: {
    _seconds: number;
    _nanoseconds: number;
  };
};

const API_BASE_URL = "https://<your-vercel-project>.vercel.app";

export async function fetchSessionOutput(sessionId: string, limit = 200) {
  const response = await fetch(
    `${API_BASE_URL}/sessions/${sessionId}/output?limit=${limit}`
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error ?? `Request failed: ${response.status}`);
  }

  const data = (await response.json()) as { chunks: OutputChunk[] };
  return data.chunks;
}

export function mergeOutputChunks(
  existing: OutputChunk[],
  incoming: OutputChunk[]
) {
  const seen = new Set(existing.map((chunk) => chunk.chunkId));
  const merged = [...existing];

  for (const chunk of incoming) {
    if (seen.has(chunk.chunkId)) continue;
    seen.add(chunk.chunkId);
    merged.push(chunk);
  }

  return merged;
}
```

## Status checks

To know whether output is still being produced, also read session status:

```http
GET /users/:userId/sessions
```

or track status changes elsewhere in your app flow.

Session statuses used by the backend:

- `active`
- `waiting_for_input`
- `running`
- `completed`
- `error`

## Current limitations

- No authentication is enforced on these routes in the current server code
- No incremental output endpoint exists yet
- No server-sent events or websocket stream exists yet
- Session expiry is currently `24 hours` after creation

If you want a better mobile fetch path later, the next backend improvement should be:

```http
GET /sessions/:sessionId/output?after=<chunkId>
```

or

```http
GET /sessions/:sessionId/output?since=<timestamp>
```
