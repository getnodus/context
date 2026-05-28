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

interface VerifySpec {
  kind: "url" | "repo" | "path"
  target: string
}

interface Confirmation {
  by: string              // agent or "user"
  at: string              // ISO 8601
  method: "verify" | "use" | "user"
}

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
  verify?: VerifySpec     // optional declarative check; see "Self-maintaining memory"
  verifiedAt?: string     // ISO 8601 — last verify attempt
  verifyStatus?: "ok" | "failed" | "unknown"
  verifyMessage?: string  // short reason on failure
  verifyAccepted?: boolean // user has explicitly accepted the current failed state
  verifyAcceptedAt?: string // ISO 8601 — when accept was recorded
  verifyAcceptedReason?: string // optional user-provided reason
  confirmations?: Confirmation[]  // append-only, deduped per (agent,day); last 12 retained
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
  verify?: VerifySpec
  verifiedAt?: string
  verifyStatus?: "ok" | "failed" | "unknown"
  verifyMessage?: string
  verifyAccepted?: boolean
  verifyAcceptedAt?: string
  verifyAcceptedReason?: string
}

interface SearchHit {
  entry: ContextEntrySummary
  score: number
  snippets: string[]
  confidence: "low" | "medium" | "high"
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
  "author": "claude-code/1.2.3",
  "verify": { "kind": "repo", "target": "getnodus/context" },
  "verifiedAt": "2026-05-27T10:00:00Z",
  "verifyStatus": "ok",
  "verifyMessage": "",
  "verifyAccepted": false,
  "verifyAcceptedAt": null,
  "verifyAcceptedReason": null,
  "confirmations": [{ "by": "claude-code", "at": "2026-05-27T10:00:00Z", "method": "verify" }]
}
```

All fields except `body` are optional. Servers should:
- preserve `created` across updates and bump `updated`
- retain the supersedes link
- if `author` is provided, set it on the entry and set `createdBy` to the same value for a new entry; preserve the existing `createdBy` on rewrites so the original creator is never lost
- accept `verify`, `verifiedAt`, `verifyStatus`, `verifyMessage`, `verifyAccepted`, `verifyAcceptedAt`, `verifyAcceptedReason`, `confirmations` and round-trip them in `GET /entries/:id`. Older servers that ignore these fields stay compatible — clients that need verification just keep using local-side defaults.
- when `verifyStatus` transitions to `ok` on a write, clear `verifyAccepted` (a passing verify has nothing left to suppress).

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

Each `SearchHit` carries a `confidence` field (`low` | `medium` | `high`). Servers that don't compute confidence can omit it; clients compute it client-side from the returned entry's verify state so the trust signal stays uniform regardless of backend. Servers SHOULD return `low` for entries with `verifyStatus: "failed"` (and not `verifyAccepted`) and `high` for entries with a recent passing verify or ≥2 distinct confirmers in the last 30 days.

Response: `{ "hits": SearchHit[] }`

### `GET /tags`

List all tags in use.

Response: `{ "tags": TagCount[] }`

## Server-side verify-on-write

When a `PUT /entries/:id` request includes a `verify` block AND no `verifyStatus`, servers SHOULD run the verify check inline (with a short timeout, ~3s) and stamp the result on the stored entry. This ensures clients that don't run their own verification (raw HTTP, older CLIs, third-party tools) still get the memory-health benefit.

Clients that have already run verify locally SHOULD send `verifyStatus` (and `verifiedAt`) in the request; servers MUST honor a pre-computed status and not re-verify.

## Optional endpoints — health

### `GET /health`

Returns a memory health audit — surfaces what's been silently accumulating. Used by `nodus-context doctor --memory` and the MCP server's `nodus-context://brief` resource so HTTP clients don't have to compute it client-side.

Response shape:

```ts
interface MemoryHealth {
  totalEntries: number
  failedVerifies: Array<ContextEntrySummary & { key: string }>
  acceptedVerifies: Array<ContextEntrySummary & { key: string; verifyAcceptedAt?: string; verifyAcceptedReason?: string }>
  neverVerified: Array<ContextEntrySummary & { key: string }>
  staleVerifies: Array<ContextEntrySummary & { key: string }>
  duplicateClusters: Array<{ ids: string[]; overlap: number; key: string }>
  issueCount: number
  urgency: { urgent: number; informational: number }
  freshStore: boolean
}
```

Each item carries a stable `key` (e.g. `failed:ref/old`, `dup:user/a|user/b`) that clients use with `acknowledge_health` to suppress repeat mentions.

- `acceptedVerifies` lists failed-verify entries the user has explicitly accepted (via `context accept`). Surfaced separately as informational so the user can see what's been silenced without it counting as an active issue.
- `urgency.urgent` counts failed-and-not-accepted verifies; `urgency.informational` counts everything else (never-checked, stale, possible duplicates). Use this to communicate severity in summary lines without conflating "needs eyes now" with "routine cleanup."
- `freshStore` is `true` when every entry was created within the last 24 hours. Clients use this to suppress never-checked nags during onboarding.

Older servers may omit `acceptedVerifies`, `urgency`, or `freshStore`; clients backfill defaults.

Servers that don't implement this endpoint should return `404`; clients fall back to computing health from `GET /entries` client-side.

## Optional endpoints — acks

Acknowledgments record that an agent already mentioned a memory-health issue to the user, so it's suppressed from the brief for 7 days. When a backend supports `/acks`, the suppression syncs across devices — an ack on the user's laptop won't be re-prompted on their desktop.

### `GET /acks`

Returns the current ack map.

Response: `{ "acks": { "failed:ref/old": "2026-05-28T12:00:00Z", … } }`

Servers that don't implement this should return `404`; clients fall back to per-machine local acks at `~/.nodus/.cache/health-acks.json`.

### `POST /acks`

Body: `{ "keys": ["failed:ref/old", "dup:user/a|user/b"] }`

Servers should record each key with the current timestamp, overwriting any prior timestamp for the same key. Response: `{ "added": <int>, "at": "<iso>" }` where `added` counts keys that were not previously present.

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
