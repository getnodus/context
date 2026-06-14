import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OllamaEmbedder,
  EmbeddingCache,
  cosineSimilarity,
  makeEmbedderFromEnv,
} from "../src/backends/embeddings.js"

// --- cosineSimilarity ---

test("cosineSimilarity: identical vectors return 1", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
})

test("cosineSimilarity: orthogonal vectors return 0", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
})

test("cosineSimilarity: opposite vectors return -1", () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1)
})

test("cosineSimilarity: mismatched lengths return 0", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
})

test("cosineSimilarity: zero vectors return 0", () => {
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0)
})

test("cosineSimilarity: one zero vector returns 0", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0)
})

test("cosineSimilarity: proportional vectors return 1", () => {
  const sim = cosineSimilarity([1, 2, 3], [2, 4, 6])
  assert.ok(Math.abs(sim - 1) < 1e-10)
})

// --- EmbeddingCache ---

test("EmbeddingCache.hashFor: produces deterministic hash", () => {
  const entry = { id: "a/b", title: "Title", type: "fact" as const, tags: ["x"], body: "hello" }
  const h1 = EmbeddingCache.hashFor(entry)
  const h2 = EmbeddingCache.hashFor(entry)
  assert.equal(h1, h2)
  assert.equal(typeof h1, "string")
  assert.ok(h1.length > 0)
})

test("EmbeddingCache.hashFor: changes with different body", () => {
  const base = { id: "a/b", title: "Title", type: "fact" as const, tags: ["x"] }
  const h1 = EmbeddingCache.hashFor({ ...base, body: "hello" })
  const h2 = EmbeddingCache.hashFor({ ...base, body: "world" })
  assert.notEqual(h1, h2)
})

test("EmbeddingCache.textFor: formats text with tags", () => {
  const entry = { id: "a/b", title: "My Title", tags: ["foo", "bar"], body: "Some body text" }
  const text = EmbeddingCache.textFor(entry)
  assert.ok(text.includes("My Title"))
  assert.ok(text.includes("a/b"))
  assert.ok(text.includes("tags: foo, bar"))
  assert.ok(text.includes("Some body text"))
})

test("EmbeddingCache.textFor: no tag line when tags empty", () => {
  const entry = { id: "a/b", title: "Title", tags: [], body: "Body" }
  const text = EmbeddingCache.textFor(entry)
  assert.ok(!text.includes("tags:"))
})

test("EmbeddingCache: save + load round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-cache-"))
  try {
    const cache = new EmbeddingCache(dir)
    await cache.save("test-id", "ollama:test", "abc123", [0.1, 0.2, 0.3])
    const loaded = await cache.load("test-id")
    assert.ok(loaded)
    assert.equal(loaded.providerId, "ollama:test")
    assert.equal(loaded.hash, "abc123")
    assert.deepEqual(loaded.vector, [0.1, 0.2, 0.3])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("EmbeddingCache: load returns null for missing id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-cache-"))
  try {
    const cache = new EmbeddingCache(dir)
    const loaded = await cache.load("nonexistent")
    assert.equal(loaded, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("EmbeddingCache: load returns null for malformed file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-cache-"))
  try {
    const cache = new EmbeddingCache(dir)
    // Write a valid entry first, then overwrite with garbage
    await cache.save("bad", "p", "h", [1])
    const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises")
    const { dirname: dn, join: jn } = await import("node:path")
    const file = jn(dir, ".embeddings", "bad.json")
    await wf(file, '{"broken": true}', "utf8")
    const loaded = await cache.load("bad")
    assert.equal(loaded, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("EmbeddingCache: forget removes cached embedding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-cache-"))
  try {
    const cache = new EmbeddingCache(dir)
    await cache.save("to-forget", "p", "h", [1, 2])
    const before = await cache.load("to-forget")
    assert.ok(before)
    await cache.forget("to-forget")
    const after = await cache.load("to-forget")
    assert.equal(after, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("EmbeddingCache: forget is safe on nonexistent id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "embed-cache-"))
  try {
    const cache = new EmbeddingCache(dir)
    await cache.forget("never-existed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- OllamaEmbedder ---

test("OllamaEmbedder: constructor throws when model is missing", () => {
  assert.throws(() => new OllamaEmbedder({ model: "" }), /model is required/)
})

test("OllamaEmbedder: sets defaults correctly", () => {
  const embedder = new OllamaEmbedder({ model: "nomic-embed-text" })
  assert.equal(embedder.id, "ollama:nomic-embed-text")
  assert.equal(embedder.dim, 768)
})

test("OllamaEmbedder: respects custom options", () => {
  const embedder = new OllamaEmbedder({
    model: "custom-model",
    url: "http://myhost:1234/",
    dim: 512,
    timeoutMs: 5000,
  })
  assert.equal(embedder.id, "ollama:custom-model")
  assert.equal(embedder.dim, 512)
})

// --- makeEmbedderFromEnv ---

test("makeEmbedderFromEnv: returns null when no env var set", () => {
  const orig = process.env.NODUS_EMBEDDING_PROVIDER
  delete process.env.NODUS_EMBEDDING_PROVIDER
  try {
    assert.equal(makeEmbedderFromEnv(), null)
  } finally {
    if (orig !== undefined) process.env.NODUS_EMBEDDING_PROVIDER = orig
  }
})

test("makeEmbedderFromEnv: creates OllamaEmbedder when provider=ollama", () => {
  const origProvider = process.env.NODUS_EMBEDDING_PROVIDER
  const origModel = process.env.NODUS_EMBEDDING_MODEL
  const origUrl = process.env.NODUS_EMBEDDING_URL
  const origDim = process.env.NODUS_EMBEDDING_DIM
  process.env.NODUS_EMBEDDING_PROVIDER = "ollama"
  process.env.NODUS_EMBEDDING_MODEL = "test-model"
  process.env.NODUS_EMBEDDING_URL = "http://custom:5555"
  process.env.NODUS_EMBEDDING_DIM = "256"
  try {
    const embedder = makeEmbedderFromEnv()
    assert.ok(embedder)
    assert.equal(embedder.id, "ollama:test-model")
    assert.equal(embedder.dim, 256)
  } finally {
    if (origProvider !== undefined) process.env.NODUS_EMBEDDING_PROVIDER = origProvider
    else delete process.env.NODUS_EMBEDDING_PROVIDER
    if (origModel !== undefined) process.env.NODUS_EMBEDDING_MODEL = origModel
    else delete process.env.NODUS_EMBEDDING_MODEL
    if (origUrl !== undefined) process.env.NODUS_EMBEDDING_URL = origUrl
    else delete process.env.NODUS_EMBEDDING_URL
    if (origDim !== undefined) process.env.NODUS_EMBEDDING_DIM = origDim
    else delete process.env.NODUS_EMBEDDING_DIM
  }
})

test("makeEmbedderFromEnv: throws on unknown provider", () => {
  const orig = process.env.NODUS_EMBEDDING_PROVIDER
  process.env.NODUS_EMBEDDING_PROVIDER = "unknown-provider"
  try {
    assert.throws(() => makeEmbedderFromEnv(), /unknown NODUS_EMBEDDING_PROVIDER/)
  } finally {
    if (orig !== undefined) process.env.NODUS_EMBEDDING_PROVIDER = orig
    else delete process.env.NODUS_EMBEDDING_PROVIDER
  }
})
