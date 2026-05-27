import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

/**
 * Use tracking sidecar. Stored separately from entry files so reads don't
 * pollute history snapshots, and so tracking can be disabled without
 * touching the markdown.
 *
 * File: <rootDir>/.usage.json
 * Shape: { "<id>": { "count": N, "lastUsedAt": "ISO" } }
 */
export interface UsageRecord {
  count: number
  lastUsedAt: string
}

export type UsageMap = Record<string, UsageRecord>

const USAGE_FILE = ".usage.json"

export class UsageTracker {
  readonly #path: string
  #cache: UsageMap | null = null

  constructor(rootDir: string) {
    this.#path = join(rootDir, USAGE_FILE)
  }

  async load(): Promise<UsageMap> {
    if (this.#cache) return this.#cache
    try {
      const raw = await readFile(this.#path, "utf8")
      this.#cache = JSON.parse(raw)
    } catch {
      this.#cache = {}
    }
    return this.#cache!
  }

  async get(id: string): Promise<UsageRecord | undefined> {
    const map = await this.load()
    return map[id]
  }

  async getMany(ids: string[]): Promise<Map<string, UsageRecord>> {
    const map = await this.load()
    const out = new Map<string, UsageRecord>()
    for (const id of ids) {
      const rec = map[id]
      if (rec) out.set(id, rec)
    }
    return out
  }

  async record(id: string): Promise<void> {
    const map = await this.load()
    const now = new Date().toISOString()
    const prev = map[id]
    map[id] = {
      count: (prev?.count ?? 0) + 1,
      lastUsedAt: now,
    }
    await this.#flush()
  }

  async forget(id: string): Promise<void> {
    const map = await this.load()
    if (id in map) {
      delete map[id]
      await this.#flush()
    }
  }

  async flush(): Promise<void> {
    await this.#flush()
  }

  async #flush(): Promise<void> {
    if (!this.#cache) return
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(tmp, JSON.stringify(this.#cache, null, 2) + "\n", "utf8")
    await rename(tmp, this.#path)
  }
}
