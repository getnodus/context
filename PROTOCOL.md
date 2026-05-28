# Nodus Context HTTP Protocol

Specification for servers that want to act as a remote backend for `@getnodus/context`. Any service implementing these endpoints can be configured as an `http` profile in a user's `~/.nodus/config.json` and used transparently by the CLI and MCP server.

The reference implementation lives in `test/stub-server.ts`. The conformance suite in `test/conformance.ts` exercises every required behavior — point it at your server to verify compliance.

## Conventions

- All requests and responses are JSON.
- All endpoints accept optional `Authorization: Bearer <token>` if the server requires auth.
- Status codes follow REST conventions: `200` on success, `404` for missing entries, `401`/`403` for auth failures, `4xx` for client errors, `5xx` for server errors.
- Entry ids are URL-encoded path segments. `user/identity` → `/entries/user/identity`. The `/` separator is preserved (not percent-encoded).
- Timestamps are ISO 8601 UTC strings.

## Data shapes

```ts
type EntryType =
  | "rule"           // always-on directive
  | "preference"     // soft preference
  | "fact"           // neutral information (default)
  | "decision"       // historical record
  | "gotcha"         // warning / edge case
  | "project-state"  // current state of an ongoing project
  | "reference"      // pointer to an external resource
  | string           // custom types are allowed

interface ContextEntry {
  id: string
  title: string
  type: EntryType
  tags: string[]
  created: string         // ISO 8601
  updated: string         // ISO 8601
  body: string            // markdown
  supersedes?: string[]   // ids of entries this one replaces
  expires?: string        // ISO 8601 — after this, entry is stale
  useCount?: number       // optional: tracked reads
  lastUsedAt?: string     // optional: tracked reads
  author?: string         // agent that last wrote, e.g. "claude-code/1.2.3"
  createdBy?: string      // agent that originally created — preserved across rewrites
}

interface ContextEntrySummary {
  id: string
  title: string
  type: EntryType
  tags: string[]
  created: string
  updated: string
  preview: string         // first ~160 chars of body
  supersedes?: string[]
  expires?: string
  useCount?: number
  lastUsedAt?: string
}

interface SearchHit {
  entry: ContextEntrySummary
  score: number
  snippets: string[]
}

interface HistorySnapshot {
  id: string
  file: string            // opaque snapshot identifier
  timestamp: string       // ISO 8601
  deletion: boolean
}

interface TagCount {
  tag: string
  count: number
}
```

## Required endpoints

### `GET /entries`

List entries. Query parameters:
- `prefix` — filter by id prefix
- `tag` — filter by tag; may be repeated to require multiple tags (AND)
- `type` — filter by entry type; may be repeated (any-of)
- `author` — filter by author; may be repeated. Matches when the entry's `author` equals the value OR when its name part (before `/`) equals the value. Example: `author=claude-code` matches both `claude-code` and `claude-code/1.2.3`.
- `sort` — `updated-desc` (default), `updated-asc`, `id-asc`
- `limit` — integer
- `includeExpired` — `1` to include expired entries (default: exclude)

Response: `{ "entries": ContextEntrySummary[] }`

### `GET /entries/:id`

Read one entry. `:id` may contain `/`.

- `200` → `ContextEntry`
- `404` → entry does not exist

### `PUT /entries/:id`

Create or update an entry. Body:

```json
{
  "body": "...",
  "title": "...",
  "type": "preference",
  "tags": ["..."],
  "supersedes": ["older/id"],
  "expires": "2026-12-31T00:00:00Z",
  "author": "claude-code/1.2.3"
}
```

All fields except `body` are optional. Servers should:
- preserve `created` across updates and bump `updated`
- retain the supersedes link
- if `author` is provided, set it on the entry and set `createdBy` to the same value for a new entry; preserve the existing `createdBy` on rewrites so the original creator is never lost

Response: `ContextEntry` representing the saved state.

### `DELETE /entries/:id`

Delete an entry.

- `200` → `{ "deleted": true }`
- `404` → did not exist

### `GET /search`

Search. Query parameters:
- `q` — query string (required)
- `limit` — integer (default 20)

Servers MAY implement substring, semantic, hybrid, or any other strategy. Returned `score` should be monotonically meaningful (higher = better) but the scale is implementation-defined.

Response: `{ "hits": SearchHit[] }`

### `GET /tags`

List all tags in use.

Response: `{ "tags": TagCount[] }`

## Optional endpoints — history

Servers MAY support history. If they don't, return `404` on the history endpoints; clients will respect that and fail the CLI command with a clear message.

### `GET /entries/:id/history`

Response: `{ "snapshots": HistorySnapshot[] }`

### `GET /entries/:id/history/:snapshotName`

Response: `ContextEntry` representing the snapshot.

### `POST /entries/:id/revert`

Body: `{ "snapshot": "...", "author": "..." }` — `snapshot` selects which prior version to restore (most recent if omitted); `author` is recorded on the resulting entry, same semantics as `PUT`.

Response: `ContextEntry` representing the restored state.

## Error responses

Any non-2xx response should include a JSON body with at minimum:

```json
{ "error": "human-readable message" }
```

Clients key off the status code, not the message.

## Versioning

This document describes v1 of the protocol. Future breaking changes will increment a version negotiated via:

```
GET /
```

Response: `{ "protocolVersion": 1, "name": "...", "capabilities": { "history": true, "semanticSearch": true } }`

Clients MAY call `GET /` at startup to discover capabilities. Implementations that omit `/` are assumed to be v1 with all optional endpoints best-effort.

## Implementation notes

- The protocol is intentionally simple. Implementations can be a thin wrapper over a Postgres + pgvector store, a Redis-backed store, S3 + Lambda, anything.
- Servers MAY impose additional constraints (e.g. body size limits, id format). Clients tolerate `4xx` with a descriptive message and surface it to the user.
- Servers MAY accept additional fields on write requests and ignore them; clients should not assume strict round-tripping of unknown fields.
- For semantic search, the recommended approach: embed query and entries (e.g. with `nomic-embed-text`), cosine similarity, blend with substring scores. See `src/backends/local.ts` for a reference.
