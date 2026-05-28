import {
  BackendDescription,
  ContextBackend,
  ContextEntry,
  ContextEntrySummary,
  ContextNotFoundError,
  HistorySnapshot,
  ListOptions,
  NotSupportedError,
  SearchHit,
  SearchOptions,
  TagCount,
  WriteInput,
} from "./types.js"

export interface MirrorBackendOptions {
  /** Backend used for reads (fast / local-first). Required. */
  primary: ContextBackend
  /** Backend mirrored to on writes (typically a remote server). Required. */
  secondary: ContextBackend
  /**
   * Called when a secondary operation fails. Defaults to writing to stderr.
   * Pass a noop to silence; pass a queue function to retry later.
   */
  onSecondaryError?: (op: string, error: Error) => void
}

/**
 * Read-from-primary, write-to-both backend. The use case: a local backend
 * (fast, offline, on-disk) mirrored to a remote backend (durable, shared
 * across devices). Reads always hit the primary first — if the entry is
 * missing locally, it falls through to the secondary and caches the result
 * back into primary. Writes go to primary synchronously; the secondary
 * write is awaited but its failure is reported (not thrown) so an offline
 * secondary doesn't break local work.
 */
export class MirrorBackend implements ContextBackend {
  readonly #primary: ContextBackend
  readonly #secondary: ContextBackend
  readonly #onError: (op: string, error: Error) => void

  constructor(options: MirrorBackendOptions) {
    this.#primary = options.primary
    this.#secondary = options.secondary
    this.#onError =
      options.onSecondaryError ??
      ((op, e) => {
        process.stderr.write(
          `[nodus-context] mirror secondary failed during ${op}: ${e.message}\n`,
        )
      })
  }

  describe(): BackendDescription {
    const p = this.#primary.describe()
    const s = this.#secondary.describe()
    return {
      type: "mirror",
      label: `mirror(${p.type} → ${s.type}) · primary: ${p.label}`,
      capabilities: {
        // Mirror inherits the primary's capabilities — that's what reads see.
        history: p.capabilities.history,
        useTracking: p.capabilities.useTracking,
        semanticSearch: p.capabilities.semanticSearch,
      },
    }
  }

  async init(): Promise<void> {
    await this.#primary.init?.()
    try {
      await this.#secondary.init?.()
    } catch (e) {
      this.#onError("init", e as Error)
    }
  }

  async close(): Promise<void> {
    await this.#primary.close?.().catch(() => {})
    await this.#secondary.close?.().catch(() => {})
  }

  async read(id: string): Promise<ContextEntry> {
    try {
      return await this.#primary.read(id)
    } catch (e) {
      if (!(e instanceof ContextNotFoundError)) throw e
    }
    // Fall through to secondary; cache into primary if found.
    let remote: ContextEntry
    try {
      remote = await this.#secondary.read(id)
    } catch (e) {
      if (e instanceof ContextNotFoundError) throw new ContextNotFoundError(id)
      // Surface the real failure (e.g. server unreachable) instead of
      // pretending the entry is missing — otherwise the caller can't
      // distinguish "doesn't exist" from "couldn't ask."
      this.#onError("read-fallback", e as Error)
      throw e
    }
    try {
      await this.#primary.write({
        id: remote.id,
        body: remote.body,
        title: remote.title,
        type: remote.type,
        tags: remote.tags,
        supersedes: remote.supersedes,
        expires: remote.expires,
        author: remote.author,
      })
    } catch (e) {
      // Cache failure is non-fatal; we still return the entry.
      this.#onError("read-cache", e as Error)
    }
    return remote
  }

  async write(input: WriteInput): Promise<ContextEntry> {
    const entry = await this.#primary.write(input)
    try {
      await this.#secondary.write(input)
    } catch (e) {
      this.#onError(`write ${input.id}`, e as Error)
    }
    return entry
  }

  async delete(id: string): Promise<void> {
    let primaryErr: unknown
    try {
      await this.#primary.delete(id)
    } catch (e) {
      primaryErr = e
    }
    try {
      await this.#secondary.delete(id)
    } catch (e) {
      if (!(e instanceof ContextNotFoundError)) {
        this.#onError(`delete ${id}`, e as Error)
      }
    }
    if (primaryErr) throw primaryErr
  }

  async list(options: ListOptions = {}): Promise<ContextEntrySummary[]> {
    // Union: start with primary (authoritative locally), then layer in any
    // ids the secondary has that primary doesn't. Re-sort and re-limit at
    // the end so the caller sees a coherent ordering.
    const primary = await this.#primary.list(options)
    const byId = new Map<string, ContextEntrySummary>()
    for (const e of primary) byId.set(e.id, e)
    try {
      const secondary = await this.#secondary.list(options)
      for (const e of secondary) {
        if (!byId.has(e.id)) byId.set(e.id, e)
      }
    } catch (e) {
      this.#onError("list", e as Error)
    }
    let merged = Array.from(byId.values())
    const sort = options.sort ?? "updated-desc"
    merged.sort((a, b) => {
      if (sort === "id-asc") return a.id.localeCompare(b.id)
      const cmp = a.updated.localeCompare(b.updated)
      return sort === "updated-asc" ? cmp : -cmp
    })
    if (options.limit) merged = merged.slice(0, options.limit)
    return merged
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const primary = await this.#primary.search(query, options)
    let secondary: SearchHit[] = []
    try {
      secondary = await this.#secondary.search(query, options)
    } catch (e) {
      this.#onError("search", e as Error)
    }
    const byId = new Map<string, SearchHit>()
    for (const hit of primary) byId.set(hit.entry.id, hit)
    for (const hit of secondary) {
      const existing = byId.get(hit.entry.id)
      if (!existing || hit.score > existing.score) byId.set(hit.entry.id, hit)
    }
    let merged = Array.from(byId.values())
    merged.sort((a, b) => b.score - a.score)
    if (options.limit) merged = merged.slice(0, options.limit)
    return merged
  }

  async listTags(): Promise<TagCount[]> {
    const counts = new Map<string, number>()
    const accumulate = (tags: TagCount[]) => {
      for (const { tag, count } of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + count)
      }
    }
    accumulate(await this.#primary.listTags())
    try {
      accumulate(await this.#secondary.listTags())
    } catch (e) {
      this.#onError("listTags", e as Error)
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  }

  async listHistory(id: string): Promise<HistorySnapshot[]> {
    if (!this.#primary.listHistory) {
      throw new NotSupportedError("history", "mirror")
    }
    return this.#primary.listHistory(id)
  }

  async readSnapshot(id: string, snapshotName: string): Promise<ContextEntry> {
    if (!this.#primary.readSnapshot) {
      throw new NotSupportedError("history", "mirror")
    }
    return this.#primary.readSnapshot(id, snapshotName)
  }

  async revert(id: string, snapshotName?: string, author?: string): Promise<ContextEntry> {
    if (!this.#primary.revert) {
      throw new NotSupportedError("history", "mirror")
    }
    const entry = await this.#primary.revert(id, snapshotName, author)
    // Propagate the reverted state to secondary so it doesn't drift.
    try {
      await this.#secondary.write({
        id: entry.id,
        body: entry.body,
        title: entry.title,
        type: entry.type,
        tags: entry.tags,
        supersedes: entry.supersedes,
        expires: entry.expires,
        author: entry.author,
      })
    } catch (e) {
      this.#onError(`revert ${id}`, e as Error)
    }
    return entry
  }
}
