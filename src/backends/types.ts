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
}

export interface SearchOptions {
  limit?: number
}

export interface SearchHit {
  entry: ContextEntrySummary
  score: number
  snippets: string[]
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
