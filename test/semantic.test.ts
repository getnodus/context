import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalBackend, EmbeddingProvider } from "../src/backends/index.js"

/**
 * Tiny deterministic embedder: maps each term to a unit vector along a fixed
 * axis. Cosine similarity works out to "do the two texts share any tokens?".
 * Lets us test the semantic search wiring without a real embedding service.
 */
function fakeEmbedder(): EmbeddingProvider {
  const vocab = new Map<string, number>()
  const dim = 32
  function index(token: string): number {
    let i = vocab.get(token)
    if (i === undefined) {
      i = vocab.size % dim
      vocab.set(token, i)
    }
    return i
  }
  return {
    id: "fake:test",
    dim,
    async embed(text: string) {
      const v = new Array(dim).fill(0)
      const tokens = text.toLowerCase().match(/[a-z]{3,}/g) ?? []
      for (const t of tokens) v[index(t)] += 1
      // L2 normalize
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
      return v.map((x) => x / norm)
    },
  }
}

async function setupSemantic() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-sem-"))
  const backend = new LocalBackend({ rootDir: dir, embedder: fakeEmbedder() })
  await backend.init()
  return { backend, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("semantic search blends with substring when embedder is configured", async () => {
  const { backend, cleanup } = await setupSemantic()
  try {
    await backend.write({
      id: "user/identity",
      body: "Fischer lives in Amsterdam Netherlands",
      tags: ["identity"],
    })
    await backend.write({
      id: "preferences/coffee",
      body: "Strong dark roast in the morning",
      tags: ["preferences"],
    })
    await backend.write({
      id: "projects/nodus",
      body: "Open source infrastructure for AI agents",
      tags: ["projects"],
    })

    // Substring fails on this query, but semantic should find "Amsterdam".
    const hits = await backend.search("netherlands location")
    assert.ok(hits.length > 0, "semantic returned hits")
    assert.equal(hits[0].entry.id, "user/identity", "best hit is identity")
  } finally {
    await cleanup()
  }
})

test("falls back gracefully when embedder throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-sem-fb-"))
  try {
    const broken: EmbeddingProvider = {
      id: "broken",
      dim: 16,
      async embed() {
        throw new Error("provider unavailable")
      },
    }
    const backend = new LocalBackend({ rootDir: dir, embedder: broken })
    await backend.init()
    await backend.write({ id: "x", body: "amsterdam" })

    const hits = await backend.search("amsterdam")
    assert.equal(hits.length, 1, "substring fallback still works")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("describe reports semanticSearch capability", async () => {
  const { backend, cleanup } = await setupSemantic()
  try {
    assert.equal(backend.describe().capabilities.semanticSearch, true)
  } finally {
    await cleanup()
  }
})

test("no embedder → semanticSearch is false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-sem-no-"))
  try {
    const backend = new LocalBackend({ rootDir: dir, embedder: null })
    await backend.init()
    assert.equal(backend.describe().capabilities.semanticSearch, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
