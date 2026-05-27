import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { ContextEntry } from "./types.js"

export interface EmbeddingProvider {
  /** Stable id of the provider, used to invalidate caches when it changes. */
  id: string
  /** Vector dimension. */
  dim: number
  /** Embed a single text and return its dense vector. */
  embed(text: string): Promise<number[]>
}

export interface OllamaEmbedderOptions {
  /** Base URL, default http://127.0.0.1:11434. */
  url?: string
  /** Model name, e.g. nomic-embed-text. Required. */
  model: string
  /** Override the embedding dimension (defaults vary by model). */
  dim?: number
  /** Request timeout. Default 30000ms. */
  timeoutMs?: number
}

export class OllamaEmbedder implements EmbeddingProvider {
  readonly id: string
  readonly dim: number
  readonly #url: string
  readonly #model: string
  readonly #timeoutMs: number

  constructor(options: OllamaEmbedderOptions) {
    if (!options.model) throw new Error("OllamaEmbedder: model is required")
    this.#url = (options.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "")
    this.#model = options.model
    this.dim = options.dim ?? 768
    this.#timeoutMs = options.timeoutMs ?? 30000
    this.id = `ollama:${this.#model}`
  }

  async embed(text: string): Promise<number[]> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs)
    try {
      const res = await fetch(`${this.#url}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.#model, prompt: text }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => "")
        throw new Error(`Ollama embeddings returned ${res.status}: ${detail.slice(0, 200)}`)
      }
      const data = (await res.json()) as { embedding?: number[] }
      if (!Array.isArray(data.embedding)) {
        throw new Error("Ollama embeddings response missing 'embedding' array")
      }
      return data.embedding
    } finally {
      clearTimeout(timer)
    }
  }
}

export function makeEmbedderFromEnv(): EmbeddingProvider | null {
  const provider = process.env.NODUS_EMBEDDING_PROVIDER
  if (!provider) return null
  switch (provider) {
    case "ollama": {
      const model = process.env.NODUS_EMBEDDING_MODEL ?? "nomic-embed-text"
      const url = process.env.NODUS_EMBEDDING_URL
      const dim = process.env.NODUS_EMBEDDING_DIM
      return new OllamaEmbedder({
        model,
        ...(url ? { url } : {}),
        ...(dim ? { dim: parseInt(dim, 10) } : {}),
      })
    }
    default:
      throw new Error(`unknown NODUS_EMBEDDING_PROVIDER: ${provider}`)
  }
}

/**
 * Disk-cached embeddings: <rootDir>/.embeddings/<id>.json
 * Cache is keyed by provider id + content hash, so it self-invalidates
 * when the entry body or the provider changes.
 */
export class EmbeddingCache {
  readonly #rootDir: string

  constructor(rootDir: string) {
    this.#rootDir = rootDir
  }

  static hashFor(entry: Pick<ContextEntry, "id" | "title" | "type" | "tags" | "body">): string {
    const h = createHash("sha256")
    h.update(entry.id)
    h.update("\n")
    h.update(entry.title)
    h.update("\n")
    h.update(entry.type)
    h.update("\n")
    h.update(entry.tags.join(","))
    h.update("\n")
    h.update(entry.body)
    return h.digest("hex")
  }

  static textFor(entry: Pick<ContextEntry, "id" | "title" | "tags" | "body">): string {
    const tagLine = entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}\n` : ""
    return `${entry.title}\n${entry.id}\n${tagLine}${entry.body}`
  }

  #fileFor(id: string): string {
    return join(this.#rootDir, ".embeddings", `${id}.json`)
  }

  async load(
    id: string,
  ): Promise<{ providerId: string; hash: string; vector: number[] } | null> {
    try {
      const raw = await readFile(this.#fileFor(id), "utf8")
      const parsed = JSON.parse(raw)
      if (
        typeof parsed.providerId !== "string" ||
        typeof parsed.hash !== "string" ||
        !Array.isArray(parsed.vector)
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  async save(id: string, providerId: string, hash: string, vector: number[]): Promise<void> {
    const file = this.#fileFor(id)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(tmp, JSON.stringify({ providerId, hash, vector }) + "\n", "utf8")
    await rename(tmp, file)
  }

  async forget(id: string): Promise<void> {
    const { rm } = await import("node:fs/promises")
    await rm(this.#fileFor(id), { force: true })
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
