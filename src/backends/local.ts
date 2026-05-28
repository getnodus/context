import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import matter from "gray-matter"
import {
  BackendDescription,
  BodyTooLargeError,
  ContextBackend,
  ContextEntry,
  ContextEntrySummary,
  ContextNotFoundError,
  HistorySnapshot,
  InvalidIdError,
  ListOptions,
  MAX_BODY_BYTES,
  SearchHit,
  SearchOptions,
  TagCount,
  WriteInput,
} from "./types.js"
import { getDefaultLocalDir, idToPath, pathToId, validateId } from "./paths.js"
import { UsageTracker } from "./usage.js"
import {
  EmbeddingCache,
  EmbeddingProvider,
  cosineSimilarity,
  makeEmbedderFromEnv,
} from "./embeddings.js"

export interface LocalBackendOptions {
  rootDir?: string
  /** Disable use tracking (default enabled). */
  trackUsage?: boolean
  /** Embedding provider for semantic search. If omitted, reads NODUS_EMBEDDING_PROVIDER env. */
  embedder?: EmbeddingProvider | null
}

export class LocalBackend implements ContextBackend {
  readonly rootDir: string
  readonly #trackUsage: boolean
  readonly #usage: UsageTracker
  readonly #embedder: EmbeddingProvider | null
  readonly #embeddings: EmbeddingCache

  constructor(options: LocalBackendOptions = {}) {
    this.rootDir = options.rootDir ?? getDefaultLocalDir()
    this.#trackUsage = options.trackUsage !== false
    this.#usage = new UsageTracker(this.rootDir)
    this.#embedder =
      options.embedder === undefined ? makeEmbedderFromEnv() : options.embedder
    this.#embeddings = new EmbeddingCache(this.rootDir)
  }

  describe(): BackendDescription {
    return {
      type: "local",
      label: `Local files at ${this.rootDir}`,
      capabilities: {
        history: true,
        useTracking: this.#trackUsage,
        semanticSearch: !!this.#embedder,
      },
    }
  }

  async close(): Promise<void> {
    await this.#usage.flush()
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
  }

  async write(input: WriteInput): Promise<ContextEntry> {
    try {
      validateId(input.id)
    } catch (e) {
      throw new InvalidIdError(input.id, (e as Error).message)
    }

    const bodyBytes = Buffer.byteLength(input.body, "utf8")
    if (bodyBytes > MAX_BODY_BYTES) {
      throw new BodyTooLargeError(bodyBytes, MAX_BODY_BYTES)
    }

    const filePath = idToPath(this.rootDir, input.id)
    await mkdir(dirname(filePath), { recursive: true })

    const now = new Date().toISOString()
    let created = now
    let createdBy = input.author
    let previous: ContextEntry | null = null
    try {
      const existing = await this.#readRaw(filePath)
      created = existing.data.created ?? now
      previous = parseEntry(input.id, existing)
      createdBy = previous.createdBy ?? createdBy
    } catch {
      // new file
    }

    if (previous) {
      await this.#snapshot(previous)
    }

    // Partial-update semantics: when a field is omitted from `input`, the
    // value on the previous entry is preserved. Pass an explicit empty value
    // (e.g. tags: []) to clear a field.
    const data: Record<string, unknown> = {
      id: input.id,
      title: input.title ?? previous?.title ?? defaultTitle(input.id),
      type: input.type ?? previous?.type ?? "fact",
      tags: dedupeTags(input.tags ?? previous?.tags ?? []),
      created,
      updated: now,
    }
    const supersedes = input.supersedes ?? previous?.supersedes
    if (supersedes && supersedes.length > 0) {
      data.supersedes = Array.from(new Set(supersedes))
    }
    const expires = input.expires ?? previous?.expires
    if (expires) data.expires = expires
    if (input.author) data.author = input.author
    if (createdBy) data.createdBy = createdBy

    const fileContents = matter.stringify(normalizeBody(input.body), data)
    await atomicWrite(filePath, fileContents)

    return {
      id: input.id,
      title: data.title as string,
      type: data.type as string,
      tags: data.tags as string[],
      created,
      updated: now,
      body: input.body.replace(/\s+$/g, ""),
      supersedes: data.supersedes as string[] | undefined,
      expires: data.expires as string | undefined,
      author: data.author as string | undefined,
      createdBy: data.createdBy as string | undefined,
    }
  }

  async read(id: string): Promise<ContextEntry> {
    const filePath = idToPath(this.rootDir, id)
    let parsed
    try {
      parsed = await this.#readRaw(filePath)
    } catch (e: any) {
      if (e.code === "ENOENT") throw new ContextNotFoundError(id)
      throw e
    }
    const entry = parseEntry(id, parsed)
    if (this.#trackUsage) {
      await this.#usage.record(id)
      const rec = await this.#usage.get(id)
      if (rec) {
        entry.useCount = rec.count
        entry.lastUsedAt = rec.lastUsedAt
      }
    }
    return entry
  }

  async delete(id: string): Promise<void> {
    const entry = await this.read(id)
    await this.#snapshot(entry, { deletion: true })
    const filePath = idToPath(this.rootDir, id)
    await rm(filePath)
    if (this.#trackUsage) await this.#usage.forget(id)
    if (this.#embedder) await this.#embeddings.forget(id).catch(() => {})
  }

  async list(options: ListOptions = {}): Promise<ContextEntrySummary[]> {
    const all = await this.#scan()
    let results = all

    if (options.prefix) {
      const prefix = options.prefix.endsWith("/")
        ? options.prefix
        : `${options.prefix}/`
      results = results.filter(
        (e) => e.id === options.prefix || e.id.startsWith(prefix),
      )
    }

    if (options.tags && options.tags.length > 0) {
      const want = options.tags
      results = results.filter((e) => want.every((t) => e.tags.includes(t)))
    }

    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type]
      results = results.filter((e) => types.includes(e.type))
    }

    if (options.author) {
      const authors = Array.isArray(options.author) ? options.author : [options.author]
      results = results.filter((e) => {
        if (!e.author) return false
        const name = e.author.split("/")[0]
        return authors.includes(name) || authors.includes(e.author)
      })
    }

    if (!options.includeExpired) {
      const now = Date.now()
      results = results.filter((e) => !e.expires || Date.parse(e.expires) > now)
    }

    const sort = options.sort ?? "updated-desc"
    results.sort((a, b) => {
      if (sort === "id-asc") return a.id.localeCompare(b.id)
      if (sort === "updated-asc") return a.updated.localeCompare(b.updated)
      return b.updated.localeCompare(a.updated)
    })

    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit)
    }

    if (this.#trackUsage && results.length > 0) {
      const usage = await this.#usage.getMany(results.map((r) => r.id))
      for (const r of results) {
        const u = usage.get(r.id)
        if (u) {
          r.useCount = u.count
          r.lastUsedAt = u.lastUsedAt
        }
      }
    }

    return results
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const trimmed = query.trim()
    if (!trimmed) return []

    const entries = await this.#scanFull()
    if (entries.length === 0) return []

    const substringHits = this.#substringSearch(query, entries)

    // If no embedder configured, return substring-only.
    if (!this.#embedder) {
      return substringHits.slice(0, options.limit ?? 20)
    }

    // Semantic + substring blend. We embed the query, score each entry by
    // cosine similarity to its cached embedding (computed lazily), and merge
    // with substring scores by id.
    let queryVec: number[]
    try {
      queryVec = await this.#embedder.embed(query)
    } catch {
      // Embedding service unavailable — fall back gracefully.
      return substringHits.slice(0, options.limit ?? 20)
    }

    const semanticById = new Map<string, number>()
    for (const entry of entries) {
      const vec = await this.#vectorFor(entry)
      if (!vec) continue
      const sim = cosineSimilarity(queryVec, vec)
      if (sim > 0.1) semanticById.set(entry.id, sim)
    }

    const merged = new Map<string, SearchHit>()
    for (const hit of substringHits) {
      merged.set(hit.entry.id, { ...hit, score: hit.score })
    }
    for (const [id, sim] of semanticById.entries()) {
      const entry = entries.find((e) => e.id === id)!
      const semScore = sim * 20 // scale into a comparable range
      const existing = merged.get(id)
      if (existing) {
        existing.score += semScore
      } else {
        merged.set(id, { entry: summarize(entry), score: semScore, snippets: [] })
      }
    }

    const hits = Array.from(merged.values())
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, options.limit ?? 20)
  }

  #substringSearch(query: string, entries: ContextEntry[]): SearchHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
    if (terms.length === 0) return []
    const hits: SearchHit[] = []

    for (const entry of entries) {
      const haystack = `${entry.id}\n${entry.title}\n${entry.tags.join(" ")}\n${entry.body}`.toLowerCase()
      let score = 0
      const snippets: string[] = []

      for (const term of terms) {
        let idx = -1
        let count = 0
        while ((idx = haystack.indexOf(term, idx + 1)) !== -1) count++
        if (count === 0) {
          score = 0
          break
        }
        score += count
        const bodyLower = entry.body.toLowerCase()
        const at = bodyLower.indexOf(term)
        if (at >= 0) {
          const start = Math.max(0, at - 40)
          const end = Math.min(entry.body.length, at + term.length + 80)
          snippets.push(snippet(entry.body, start, end))
        }
      }

      if (score > 0) {
        const idLower = entry.id.toLowerCase()
        const titleLower = entry.title.toLowerCase()
        for (const term of terms) {
          if (idLower.includes(term)) score += 5
          if (titleLower.includes(term)) score += 3
        }
        hits.push({ entry: summarize(entry), score, snippets: snippets.slice(0, 3) })
      }
    }

    hits.sort((a, b) => b.score - a.score)
    return hits
  }

  async #vectorFor(entry: ContextEntry): Promise<number[] | null> {
    if (!this.#embedder) return null
    const hash = EmbeddingCache.hashFor(entry)
    const cached = await this.#embeddings.load(entry.id)
    if (cached && cached.providerId === this.#embedder.id && cached.hash === hash) {
      return cached.vector
    }
    try {
      const text = EmbeddingCache.textFor(entry)
      const vector = await this.#embedder.embed(text)
      await this.#embeddings.save(entry.id, this.#embedder.id, hash, vector)
      return vector
    } catch {
      return null
    }
  }

  async listTags(): Promise<TagCount[]> {
    const entries = await this.#scan()
    const counts = new Map<string, number>()
    for (const e of entries) {
      for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  async listHistory(id: string): Promise<HistorySnapshot[]> {
    const dir = this.#historyDir(id)
    try {
      const files = await readdir(dir)
      const snapshots: HistorySnapshot[] = []
      for (const name of files) {
        if (!name.endsWith(".md")) continue
        const parsed = parseSnapshotName(name)
        if (!parsed) continue
        snapshots.push({ id, ...parsed })
      }
      snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      return snapshots
    } catch (e: any) {
      if (e.code === "ENOENT") return []
      throw e
    }
  }

  async readSnapshot(id: string, snapshotName: string): Promise<ContextEntry> {
    const dir = this.#historyDir(id)
    const file = join(dir, snapshotName)
    try {
      const raw = await readFile(file, "utf8")
      return parseEntry(id, matter(raw))
    } catch (e: any) {
      if (e.code === "ENOENT") throw new Error(`no snapshot "${snapshotName}" for ${id}`)
      throw e
    }
  }

  async revert(id: string, snapshotName?: string, author?: string): Promise<ContextEntry> {
    const snapshots = await this.listHistory(id)
    if (snapshots.length === 0) throw new Error(`no history for ${id}`)
    const target = snapshotName ? snapshots.find((s) => s.file === snapshotName) : snapshots[0]
    if (!target) throw new Error(`no snapshot "${snapshotName}" for ${id}`)
    const snap = await this.readSnapshot(id, target.file)
    return this.write({
      id,
      body: snap.body,
      title: snap.title,
      type: snap.type,
      tags: snap.tags,
      supersedes: snap.supersedes,
      expires: snap.expires,
      author: author ?? snap.author,
    })
  }

  #historyDir(id: string): string {
    return join(this.rootDir, ".history", id)
  }

  async #snapshot(entry: ContextEntry, opts: { deletion?: boolean } = {}): Promise<void> {
    const dir = this.#historyDir(entry.id)
    await mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const suffix = opts.deletion ? ".deleted.md" : ".md"
    const file = join(dir, `${ts}${suffix}`)
    const data: Record<string, unknown> = {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      tags: entry.tags,
      created: entry.created,
      updated: entry.updated,
    }
    if (entry.supersedes && entry.supersedes.length > 0) data.supersedes = entry.supersedes
    if (entry.expires) data.expires = entry.expires
    if (entry.author) data.author = entry.author
    if (entry.createdBy) data.createdBy = entry.createdBy
    if (opts.deletion) data.deleted = true
    const content = matter.stringify(normalizeBody(entry.body), data)
    await atomicWrite(file, content)
  }

  async #readRaw(filePath: string) {
    const raw = await readFile(filePath, "utf8")
    return matter(raw)
  }

  async #scan(): Promise<ContextEntrySummary[]> {
    const full = await this.#scanFull()
    return full.map(summarize)
  }

  async #scanFull(): Promise<ContextEntry[]> {
    try {
      await stat(this.rootDir)
    } catch {
      return []
    }
    const files = await walkMarkdown(this.rootDir)
    const out: ContextEntry[] = []
    for (const filePath of files) {
      try {
        const id = pathToId(this.rootDir, filePath)
        const parsed = await this.#readRaw(filePath)
        out.push(parseEntry(id, parsed))
      } catch {
        // skip unparseable
      }
    }
    return out
  }
}

function parseEntry(id: string, parsed: matter.GrayMatterFile<string>): ContextEntry {
  const data = parsed.data as Record<string, unknown>
  return {
    id,
    title: (data.title as string) ?? defaultTitle(id),
    type: (data.type as string) ?? "fact",
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    created: (data.created as string) ?? new Date(0).toISOString(),
    updated: (data.updated as string) ?? new Date(0).toISOString(),
    body: parsed.content.replace(/\s+$/g, ""),
    ...(Array.isArray(data.supersedes) ? { supersedes: data.supersedes as string[] } : {}),
    ...(typeof data.expires === "string" ? { expires: data.expires } : {}),
    ...(typeof data.author === "string" ? { author: data.author } : {}),
    ...(typeof data.createdBy === "string" ? { createdBy: data.createdBy } : {}),
  }
}

function parseSnapshotName(name: string): Omit<HistorySnapshot, "id"> | null {
  const deletion = name.endsWith(".deleted.md")
  const stem = deletion ? name.slice(0, -".deleted.md".length) : name.slice(0, -".md".length)
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stem)
  if (!m) return null
  const [, date, hh, mm, ss, ms] = m
  return {
    file: name,
    timestamp: `${date}T${hh}:${mm}:${ss}.${ms}Z`,
    deletion,
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, contents, "utf8")
  await rename(tmp, filePath)
}

async function walkMarkdown(rootDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue
        await walk(full)
      } else if (e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".")) {
        out.push(full)
      }
    }
  }
  await walk(rootDir)
  return out
}

function summarize(entry: ContextEntry): ContextEntrySummary {
  const trimmed = entry.body.trim()
  const preview =
    trimmed.length > 160 ? trimmed.slice(0, 157).trimEnd() + "..." : trimmed
  return {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    tags: entry.tags,
    created: entry.created,
    updated: entry.updated,
    preview,
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    ...(entry.expires ? { expires: entry.expires } : {}),
    ...(entry.author ? { author: entry.author } : {}),
    ...(entry.createdBy ? { createdBy: entry.createdBy } : {}),
  }
}

function defaultTitle(id: string): string {
  const last = id.split("/").pop() ?? id
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function dedupeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((t) => t.trim()).filter((t) => t)))
}

function normalizeBody(body: string): string {
  const trimmed = body.replace(/\s+$/g, "")
  return trimmed.length > 0 ? trimmed + "\n" : ""
}

function snippet(body: string, start: number, end: number): string {
  const text = body.slice(start, end).replace(/\s+/g, " ").trim()
  const prefix = start > 0 ? "..." : ""
  const suffix = end < body.length ? "..." : ""
  return prefix + text + suffix
}
