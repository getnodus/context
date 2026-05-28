/**
 * Canonical entry types. The set is documented and recommended but not strictly
 * enforced — callers may pass any string. Each type carries a semantic hint
 * about how the LLM should treat the entry.
 *
 *  - `rule`           — always-on directive ("never use --no-verify")
 *  - `preference`     — soft preference ("prefers terse responses")
 *  - `fact`           — neutral information ("user is in Amsterdam")
 *  - `decision`       — historical record of a choice made
 *  - `gotcha`         — warning / edge case to remember
 *  - `project-state`  — current state of an ongoing project (may go stale)
 *  - `reference`      — pointer to an external system / document
 */
export const ENTRY_TYPES = [
  "rule",
  "preference",
  "fact",
  "decision",
  "gotcha",
  "project-state",
  "reference",
] as const

export type EntryType = (typeof ENTRY_TYPES)[number] | (string & {})

/**
 * Declarative check that proves an entry still reflects reality.
 *
 * Kinds:
 *  - `url`  — HTTP GET; ok on 2xx.
 *  - `repo` — GitHub repo by `owner/name`; ok if reachable AND not archived.
 *  - `path` — local filesystem path; ok if it exists.
 *
 * `command` is intentionally absent; running arbitrary shell from frontmatter
 * is a footgun. May be added behind explicit opt-in later.
 */
export interface VerifySpec {
  kind: "url" | "repo" | "path"
  target: string
}

export type VerifyStatus = "ok" | "failed" | "unknown"

export interface Confirmation {
  /** Agent or user that confirmed the entry. */
  by: string
  /** ISO timestamp. */
  at: string
  /**
   * How the entry was confirmed:
   *  - `verify` — automated verify spec passed
   *  - `use`    — agent cited the entry in a session and the user did not correct
   *  - `user`   — user explicitly reaffirmed
   */
  method: "verify" | "use" | "user"
}

/** Coarse trust signal exposed in search results. */
export type Confidence = "low" | "medium" | "high"

export interface ContextEntry {
  /** Path-style identifier, e.g. "user/identity" or "projects/nodus". */
  id: string
  /** Human-readable title for UI display. */
  title: string
  /** Semantic type (see ENTRY_TYPES). Defaults to "fact". */
  type: EntryType
  /** Free-form tags for cross-cutting categorization. */
  tags: string[]
  /** ISO timestamp. */
  created: string
  /** ISO timestamp. */
  updated: string
  /** Markdown body, trimmed of trailing whitespace. */
  body: string
  /** Ids of entries this one logically replaces. */
  supersedes?: string[]
  /** ISO timestamp after which this entry is stale. Filtered from default list/search. */
  expires?: string
  /** Read count, if tracking is enabled. */
  useCount?: number
  /** ISO timestamp of the most recent read, if tracking is enabled. */
  lastUsedAt?: string
  /**
   * Agent that last wrote this entry, e.g. "claude-code", "cursor",
   * "codex", or "cli". Optional version may be appended after a slash:
   * "claude-code/1.2.3".
   */
  author?: string
  /** Agent that originally created this entry. Preserved across overwrites. */
  createdBy?: string
  /** Declarative reality check; run by `confirm_context` / `nodus-context verify`. */
  verify?: VerifySpec
  /** ISO timestamp of the most recent verification attempt. */
  verifiedAt?: string
  /** Outcome of the most recent verification. */
  verifyStatus?: VerifyStatus
  /** Short human-readable reason when verifyStatus is "failed". */
  verifyMessage?: string
  /** Append-only log of confirmations (verify success, user reaffirmation, agent citation). Last 8 kept. */
  confirmations?: Confirmation[]
}

export interface ContextEntrySummary {
  id: string
  title: string
  type: EntryType
  tags: string[]
  created: string
  updated: string
  /** First ~160 chars of the body. */
  preview: string
  supersedes?: string[]
  expires?: string
  useCount?: number
  lastUsedAt?: string
  author?: string
  createdBy?: string
  verify?: VerifySpec
  verifiedAt?: string
  verifyStatus?: VerifyStatus
  verifyMessage?: string
}

export interface SearchOptions {
  limit?: number
}

export interface SearchHit {
  entry: ContextEntrySummary
  score: number
  snippets: string[]
  /**
   * Coarse trust signal. Agents should treat `low` as a prompt to verify the
   * entry (via `confirm_context`) before relying on it — they should not
   * surface this to the user as uncertainty.
   */
  confidence: Confidence
}

export interface WriteInput {
  id: string
  body: string
  title?: string
  type?: EntryType
  tags?: string[]
  supersedes?: string[]
  expires?: string
  /**
   * Identifier of the agent making this write. Recorded as `author` on the
   * resulting entry. Examples: "claude-code", "cursor", "codex", "cli".
   */
  author?: string
  /** Declarative reality check; see VerifySpec. */
  verify?: VerifySpec
  /** Verification outcome (set by `confirm_context`, rarely by hand). */
  verifiedAt?: string
  verifyStatus?: VerifyStatus
  verifyMessage?: string
  /** Append-only confirmation log; replaces previous when present. */
  confirmations?: Confirmation[]
}

export interface ListOptions {
  /** Filter to entries whose id starts with this prefix. */
  prefix?: string
  /** Filter to entries that have ALL of these tags. */
  tags?: string[]
  /** Filter to entries of this type (or any of these types). */
  type?: EntryType | EntryType[]
  /** Filter to entries by author (or any of these authors, exact match on name part). */
  author?: string | string[]
  sort?: "updated-desc" | "updated-asc" | "id-asc"
  limit?: number
  /** If true, include expired entries (default false). */
  includeExpired?: boolean
}

export interface HistorySnapshot {
  id: string
  /** Opaque snapshot name (filename for local backend, id for others). */
  file: string
  /** ISO timestamp of the snapshot. */
  timestamp: string
  /** True if this snapshot was taken at delete time. */
  deletion: boolean
}

export interface TagCount {
  tag: string
  count: number
}

export interface BackendDescription {
  /** Stable type identifier, e.g. "local", "http", "module". */
  type: string
  /** Human-readable label, e.g. "Local files at ~/.nodus/context". */
  label: string
  capabilities: {
    history: boolean
    /** Backend records read counts / last-used timestamps. */
    useTracking?: boolean
    /** Backend supports semantic search via embeddings. */
    semanticSearch?: boolean
  }
}

/**
 * Contract for any storage backend behind @getnodus/context.
 *
 * Required methods provide CRUD + search + tag listing. History-related
 * methods are optional — backends without history support should leave
 * them undefined; callers should check `describe().capabilities.history`
 * before calling.
 */
export interface ContextBackend {
  /** Called once at startup. Backends use this to create directories, open connections, etc. */
  init?(): Promise<void>
  /** Called on graceful shutdown. */
  close?(): Promise<void>

  describe(): BackendDescription

  read(id: string): Promise<ContextEntry>
  write(input: WriteInput): Promise<ContextEntry>
  delete(id: string): Promise<void>
  list(options?: ListOptions): Promise<ContextEntrySummary[]>
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>
  listTags(): Promise<TagCount[]>

  listHistory?(id: string): Promise<HistorySnapshot[]>
  readSnapshot?(id: string, snapshotName: string): Promise<ContextEntry>
  revert?(id: string, snapshotName?: string, author?: string): Promise<ContextEntry>

  /**
   * Optional. When implemented, callers (the MCP brief, `doctor --memory`)
   * use this instead of computing health client-side. HTTP backends
   * implement this by calling `GET /health` on the server — avoids
   * transferring full entry lists across the network just to compute a
   * summary. Local backends compute it directly.
   */
  health?(options?: { now?: number; duplicateScanLimit?: number }): Promise<import("./types.js").MemoryHealthShape>
}

/**
 * Mirrors the `MemoryHealth` shape defined in `./health.js`. Kept as a
 * forward declaration here so the backend interface doesn't pull the
 * health module into the dependency graph.
 */
export interface MemoryHealthShape {
  totalEntries: number
  failedVerifies: Array<ContextEntrySummary & { key: string }>
  neverVerified: Array<ContextEntrySummary & { key: string }>
  staleVerifies: Array<ContextEntrySummary & { key: string }>
  duplicateClusters: Array<{ ids: string[]; overlap: number; key: string }>
  issueCount: number
}

export class ContextNotFoundError extends Error {
  constructor(id: string) {
    super(`No context entry found with id "${id}"`)
    this.name = "ContextNotFoundError"
  }
}

export class InvalidIdError extends Error {
  constructor(id: string, reason: string) {
    super(`Invalid context id "${id}": ${reason}`)
    this.name = "InvalidIdError"
  }
}

export class BodyTooLargeError extends Error {
  constructor(size: number, max: number) {
    super(`body is ${size} bytes; max is ${max} bytes`)
    this.name = "BodyTooLargeError"
  }
}

export class NotSupportedError extends Error {
  constructor(capability: string, backendType: string) {
    super(`${capability} is not supported by the ${backendType} backend`)
    this.name = "NotSupportedError"
  }
}

export class BackendError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "BackendError"
  }
}

/** Max body size in bytes — defensive cap. */
export const MAX_BODY_BYTES = 256 * 1024
