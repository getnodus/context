import {
  BackendDescription,
  BackendError,
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
import { computeMemoryHealthDirect, type MemoryHealth } from "./health.js"

export interface HttpBackendOptions {
  /** Base URL, e.g. "https://memory.example.com" — no trailing slash. */
  url: string
  /** Optional bearer token for Authorization header. */
  token?: string
  /** Additional headers (e.g. for non-bearer auth schemes). */
  headers?: Record<string, string>
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number
  /** Override label shown by `doctor`. */
  label?: string
  /** Set to false to declare that this backend's server does not support history endpoints. */
  history?: boolean
  /** Optional fetch implementation (for testing). */
  fetch?: typeof fetch
}

/**
 * Generic HTTP backend. Speaks the Nodus Context HTTP Protocol documented
 * in PROTOCOL.md. Any server implementing those endpoints can serve as a
 * backend — e.g. a thin wrapper over your existing memory MCP / DB.
 */
export class HttpBackend implements ContextBackend {
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #timeoutMs: number
  readonly #label: string
  readonly #history: boolean
  readonly #fetch: typeof fetch

  constructor(options: HttpBackendOptions) {
    if (!options.url) throw new BackendError("HttpBackend: url is required")
    this.#url = options.url.replace(/\/+$/, "")
    this.#headers = {
      "content-type": "application/json",
      accept: "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    }
    this.#timeoutMs = options.timeoutMs ?? 10000
    this.#label = options.label ?? `Remote backend at ${this.#url}`
    this.#history = options.history !== false
    this.#fetch = options.fetch ?? fetch
  }

  describe(): BackendDescription {
    return {
      type: "http",
      label: this.#label,
      capabilities: { history: this.#history },
    }
  }

  async read(id: string): Promise<ContextEntry> {
    const res = await this.#req("GET", `/entries/${encodeId(id)}`)
    if (res.status === 404) throw new ContextNotFoundError(id)
    return (await this.#json(res)) as ContextEntry
  }

  async write(input: WriteInput): Promise<ContextEntry> {
    const res = await this.#req("PUT", `/entries/${encodeId(input.id)}`, {
      body: input.body,
      title: input.title,
      type: input.type,
      tags: input.tags,
      supersedes: input.supersedes,
      expires: input.expires,
      author: input.author,
      verify: input.verify,
      verifiedAt: input.verifiedAt,
      verifyStatus: input.verifyStatus,
      verifyMessage: input.verifyMessage,
      confirmations: input.confirmations,
    })
    return (await this.#json(res)) as ContextEntry
  }

  async delete(id: string): Promise<void> {
    const res = await this.#req("DELETE", `/entries/${encodeId(id)}`)
    if (res.status === 404) throw new ContextNotFoundError(id)
    await this.#consume(res)
  }

  async list(options: ListOptions = {}): Promise<ContextEntrySummary[]> {
    const params = new URLSearchParams()
    if (options.prefix) params.set("prefix", options.prefix)
    if (options.tags) for (const t of options.tags) params.append("tag", t)
    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type]
      for (const t of types) params.append("type", t)
    }
    if (options.author) {
      const authors = Array.isArray(options.author) ? options.author : [options.author]
      for (const a of authors) params.append("author", a)
    }
    if (options.sort) params.set("sort", options.sort)
    if (options.limit) params.set("limit", String(options.limit))
    if (options.includeExpired) params.set("includeExpired", "1")
    const res = await this.#req("GET", `/entries${params.size > 0 ? `?${params}` : ""}`)
    const body = (await this.#json(res)) as { entries?: ContextEntrySummary[] } | ContextEntrySummary[]
    return Array.isArray(body) ? body : (body.entries ?? [])
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q: query })
    if (options.limit) params.set("limit", String(options.limit))
    const res = await this.#req("GET", `/search?${params}`)
    const body = (await this.#json(res)) as { hits?: SearchHit[] } | SearchHit[]
    const hits = Array.isArray(body) ? body : (body.hits ?? [])
    // Older servers don't return a confidence field; default to "medium" so
    // the client surface is uniform regardless of backend.
    for (const hit of hits) {
      if (hit.confidence !== "low" && hit.confidence !== "medium" && hit.confidence !== "high") {
        hit.confidence = "medium"
      }
    }
    return hits
  }

  async listTags(): Promise<TagCount[]> {
    const res = await this.#req("GET", "/tags")
    const body = (await this.#json(res)) as { tags?: TagCount[] } | TagCount[]
    return Array.isArray(body) ? body : (body.tags ?? [])
  }

  async health(options: { now?: number; duplicateScanLimit?: number } = {}): Promise<MemoryHealth> {
    try {
      const res = await this.#req("GET", "/health")
      if (res.status === 404) {
        // Older server that doesn't implement /health — fall back to
        // client-side computation over /entries. Slower but correct.
        return computeMemoryHealthDirect(this, options)
      }
      const body = (await this.#json(res)) as MemoryHealth
      return body
    } catch (e) {
      // Server unreachable or returned malformed payload — degrade gracefully.
      if (e instanceof BackendError) throw e
      return computeMemoryHealthDirect(this, options)
    }
  }

  async listHistory(id: string): Promise<HistorySnapshot[]> {
    if (!this.#history) throw new NotSupportedError("history", "http")
    const res = await this.#req("GET", `/entries/${encodeId(id)}/history`)
    if (res.status === 404) return []
    const body = (await this.#json(res)) as { snapshots?: HistorySnapshot[] } | HistorySnapshot[]
    return Array.isArray(body) ? body : (body.snapshots ?? [])
  }

  async readSnapshot(id: string, snapshotName: string): Promise<ContextEntry> {
    if (!this.#history) throw new NotSupportedError("history", "http")
    const res = await this.#req(
      "GET",
      `/entries/${encodeId(id)}/history/${encodeURIComponent(snapshotName)}`,
    )
    if (res.status === 404) throw new Error(`no snapshot "${snapshotName}" for ${id}`)
    return (await this.#json(res)) as ContextEntry
  }

  async revert(id: string, snapshotName?: string, author?: string): Promise<ContextEntry> {
    if (!this.#history) throw new NotSupportedError("history", "http")
    const res = await this.#req("POST", `/entries/${encodeId(id)}/revert`, {
      snapshot: snapshotName,
      ...(author ? { author } : {}),
    })
    if (res.status === 404) throw new Error(`no history for ${id}`)
    return (await this.#json(res)) as ContextEntry
  }

  async #req(method: string, path: string, body?: unknown): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs)
    try {
      const res = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers: this.#headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (res.status >= 500) {
        throw new BackendError(`backend returned ${res.status} ${res.statusText} from ${method} ${path}`)
      }
      if (res.status === 401 || res.status === 403) {
        throw new BackendError(`backend rejected request (${res.status}) — check your token`)
      }
      if (res.status >= 400 && res.status !== 404) {
        const text = await res.text().catch(() => "")
        throw new BackendError(`backend returned ${res.status}: ${text.slice(0, 200)}`)
      }
      return res
    } catch (e: any) {
      if (e instanceof BackendError || e instanceof ContextNotFoundError || e instanceof NotSupportedError) {
        throw e
      }
      if (e?.name === "AbortError") {
        throw new BackendError(`backend request timed out after ${this.#timeoutMs}ms (${method} ${path})`)
      }
      throw new BackendError(`backend request failed: ${e?.message ?? String(e)}`, e)
    } finally {
      clearTimeout(timer)
    }
  }

  async #json(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch (e) {
      throw new BackendError(`backend returned non-JSON response (${res.status})`, e)
    }
  }

  async #consume(res: Response): Promise<void> {
    await res.body?.cancel?.()
  }
}

function encodeId(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/")
}
