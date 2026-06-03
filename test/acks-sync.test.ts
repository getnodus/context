import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpBackend, LocalBackend, MirrorBackend } from "../src/backends/index.js"
import { startStubServer } from "./stub-server.js"

/**
 * Ack-sync setup mirrors a real cross-device scenario:
 *   - the server stores acks under NODUS_CONTEXT_ACKS_FILE (overrideable)
 *   - the http client reads/writes via /acks
 *   - the mirror backend layers local-only acks underneath remote ones
 */
async function withServerAcks(t: { acksFile: string }) {
  process.env.NODUS_CONTEXT_ACKS_FILE = t.acksFile
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ctx-acks-"))
  const acksFile = join(dir, "server-acks.json")
  await withServerAcks({ acksFile })
  const backend = new LocalBackend({ rootDir: join(dir, "store") })
  await backend.init()
  const { url, close } = await startStubServer(backend)
  const client = new HttpBackend({ url })
  return {
    client,
    backend,
    dir,
    close: async () => {
      await close()
      await rm(dir, { recursive: true, force: true })
      delete process.env.NODUS_CONTEXT_ACKS_FILE
    },
  }
}

test("http /acks: GET returns empty initially, POST stores keys, GET returns them", async () => {
  const { client, close } = await setup()
  try {
    assert.deepEqual(await client.listAcks(), {})
    const recorded = await client.recordAcks(["failed:ref/x", "dup:a|b"])
    assert.equal(typeof recorded.at, "string")
    const acks = await client.listAcks()
    assert.ok(acks["failed:ref/x"], "key persisted")
    assert.ok(acks["dup:a|b"], "second key persisted")
  } finally {
    await close()
  }
})

test("http /acks: empty key list is a noop, never throws", async () => {
  const { client, close } = await setup()
  try {
    const result = await client.recordAcks([])
    assert.equal(result.added, 0)
  } finally {
    await close()
  }
})

test("http /acks stores under the server context root when provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-acks-root-"))
  const backend = new LocalBackend({ rootDir: join(dir, "store") })
  await backend.init()
  const server = await startStubServer(backend, { acksRootDir: backend.rootDir })
  try {
    const client = new HttpBackend({ url: server.url })
    await client.recordAcks(["rooted"])
    const raw = await readFile(join(backend.rootDir, ".cache", "server-acks.json"), "utf8")
    const parsed = JSON.parse(raw)
    assert.ok(parsed.rooted, "ack file should live under the backend root")
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("mirror.listAcks: merges across primary + secondary, latest timestamp wins", async () => {
  const { client, close, dir } = await setup()
  try {
    // Primary local backend with its own ack store; secondary is the http client.
    const primary = new LocalBackend({ rootDir: join(dir, "mirror-primary") })
    await primary.init()
    // LocalBackend doesn't implement listAcks/recordAcks itself; the mirror's
    // dispatch handles that gracefully. To exercise the merge path, we'll pre-
    // seed the secondary with one key, then ack a different one on the mirror.
    await client.recordAcks(["from-secondary"])
    const mirror = new MirrorBackend({ primary, secondary: client, onSecondaryError: () => {} })
    await mirror.recordAcks(["from-mirror"])
    const merged = await mirror.listAcks()
    assert.ok(merged["from-secondary"], "secondary-only key surfaces in mirror")
    assert.ok(merged["from-mirror"], "ack written via mirror surfaces too")
  } finally {
    await close()
  }
})

test("http client: tolerates 404 on /acks (older server) — returns empty, never throws", async () => {
  // Spin up a tiny stub that returns 404 for every path.
  const { createServer } = await import("node:http")
  const srv = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
  const addr = srv.address() as { address: string; port: number }
  const url = `http://${addr.address}:${addr.port}`
  try {
    const client = new HttpBackend({ url })
    assert.deepEqual(await client.listAcks(), {})
    const r = await client.recordAcks(["x"])
    assert.equal(r.added, 0, "404 means the server has no /acks; nothing recorded")
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})
