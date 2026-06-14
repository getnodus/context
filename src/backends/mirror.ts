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
import { computeMemoryHealthDirect, type MemoryHealth, type HealthOptions } from "./health.js"
import { toWriteInput, sameEntryContent } from "./entry-utils.js"

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
          `[context] mirror secondary failed during ${op}: ${e.message}\n`,
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
    await this.#primary.close?.().catch((e) => this.#onError("close-primary", e as Error))
    await this.#secondary.close?.().catch((e) => this.#onError("close-secondary", e as Error))
  }

  async read(id: string): Promise<ContextEntry> {
    let local: ContextEntry | undefined
    try {
      local = await this.#primary.read(id)
    } catch (e) {
      if (!(e instanceof ContextNotFoundError)) throw e
    }

    if (local) {
      try {
        const remote = await this.#secondary.read(id)
        if (sameEntryContent(local, remote)) return local
        if (isNewer(remote.updated, local.updated)) {
          await this.#cachePrimary(remote)
          return remote
        }
        if (isNewer(local.updated, remote.updated)) {
          await this.#secondary.write(toWriteInput(local)).catch((e) => this.#onError(`read-sync ${id}`, e as Error))
        }
      } catch (e) {
        if (!(e instanceof ContextNotFoundError)) {
          this.#onError("read-check-secondary", e as Error)
        } else {
          await this.#secondary.write(toWriteInput(local)).catch((err) => this.#onError(`read-fill ${id}`, err as Error))
        }
      }
      return local
    }

    // Local miss: fall through to secondary; cache into primary if found.
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
    await this.#cachePrimary(remote)
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
        const existing = byId.get(e.id)
        if (!existing || isNewer(e.updated, existing.updated)) byId.set(e.id, e)
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
      if (!existing || isNewer(hit.entry.updated, existing.entry.updated) || hit.score > existing.score) {
        byId.set(hit.entry.id, hit)
      }
    }
    let merged = Array.from(byId.values())
    merged.sort((a, b) => b.score - a.score)
    if (options.limit) merged = merged.slice(0, options.limit)
    return merged
  }

  async health(options: HealthOptions = {}): Promise<MemoryHealth> {
    // Reads come from primary; health follows the same authority. Falls back
    // to direct computation if the primary doesn't implement health().
    if (this.#primary.health) return this.#primary.health(options)
    return computeMemoryHealthDirect(this.#primary, options)
  }

  async listAcks(): Promise<Record<string, string>> {
    // Acks from EITHER device count — a user who said "I saw it" on device A
    // shouldn't be re-prompted on device B. Take the latest timestamp per key
    // across both. Secondary is the cross-device source of truth; primary
    // covers device-local acks made while offline.
    const merged: Record<string, string> = {}
    const merge = (acks: Record<string, string>) => {
      for (const [k, v] of Object.entries(acks)) {
        if (!merged[k] || v > merged[k]) merged[k] = v
      }
    }
    if (this.#primary.listAcks) {
      try {
        merge(await this.#primary.listAcks())
      } catch (e) {
        this.#onError("listAcks-primary", e as Error)
      }
    }
    if (this.#secondary.listAcks) {
      try {
        merge(await this.#secondary.listAcks())
      } catch (e) {
        this.#onError("listAcks-secondary", e as Error)
      }
    }
    return merged
  }

  async recordAcks(keys: string[]): Promise<{ added: number; at: string }> {
    // Write to both. Primary is authoritative for the return value (it's the
    // local side and never fails because of network). Secondary failure is
    // logged but non-fatal so offline acks still work.
    let result = { added: 0, at: new Date().toISOString() }
    if (this.#primary.recordAcks) {
      try {
        result = await this.#primary.recordAcks(keys)
      } catch (e) {
        this.#onError("recordAcks-primary", e as Error)
      }
    }
    if (this.#secondary.recordAcks) {
      try {
        await this.#secondary.recordAcks(keys)
      } catch (e) {
        this.#onError("recordAcks-secondary", e as Error)
      }
    }
    return result
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
      await this.#secondary.write(toWriteInput(entry))
    } catch (e) {
      this.#onError(`revert ${id}`, e as Error)
    }
    return entry
  }

  async #cachePrimary(entry: ContextEntry): Promise<void> {
    try {
      await this.#primary.write(toWriteInput(entry))
    } catch (e) {
      // Cache failure is non-fatal; we still return the entry.
      this.#onError("read-cache", e as Error)
    }
  }
}

function isNewer(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false
  if (!b) return true
  return a > b
}


