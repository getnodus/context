import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ContextNotFoundError,
  LocalBackend,
  MirrorBackend,
} from "../src/backends/index.js"

async function setupPair() {
  const a = await mkdtemp(join(tmpdir(), "nodus-mirror-primary-"))
  const b = await mkdtemp(join(tmpdir(), "nodus-mirror-secondary-"))
  const primary = new LocalBackend({ rootDir: a })
  const secondary = new LocalBackend({ rootDir: b })
  await primary.init()
  await secondary.init()
  // Swallow secondary errors in tests by default; individual tests can override
  // by passing onSecondaryError when needed.
  const mirror = new MirrorBackend({ primary, secondary, onSecondaryError: () => {} })
  await mirror.init()
  return {
    mirror,
    primary,
    secondary,
    cleanup: async () => {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    },
  }
}

test("[mirror] writes go to both backends", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await mirror.write({ id: "user/identity", body: "hello" })
    const p = await primary.read("user/identity")
    const s = await secondary.read("user/identity")
    assert.equal(p.body, "hello")
    assert.equal(s.body, "hello")
  } finally {
    await cleanup()
  }
})

test("[mirror] read prefers primary, falls back to secondary, caches", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    // Write only to secondary (simulates "remote has it, local doesn't yet")
    await secondary.write({ id: "remote-only", body: "from-server" })
    const got = await mirror.read("remote-only")
    assert.equal(got.body, "from-server")
    // Should now be cached locally
    const cached = await primary.read("remote-only")
    assert.equal(cached.body, "from-server")
  } finally {
    await cleanup()
  }
})

test("[mirror] read missing on both throws ContextNotFoundError", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    await assert.rejects(() => mirror.read("nope"), ContextNotFoundError)
  } finally {
    await cleanup()
  }
})

test("[mirror] list merges unique ids from both", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "only-primary", body: "a" })
    await secondary.write({ id: "only-secondary", body: "b" })
    await primary.write({ id: "in-both", body: "p" })
    await secondary.write({ id: "in-both", body: "s" })
    const list = await mirror.list({ sort: "id-asc" })
    const ids = list.map((e) => e.id)
    assert.deepEqual(ids, ["in-both", "only-primary", "only-secondary"])
  } finally {
    await cleanup()
  }
})

test("[mirror] read returns newer secondary copy and refreshes primary", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "shared", body: "old local" })
    await new Promise((r) => setTimeout(r, 10))
    await secondary.write({ id: "shared", body: "new remote" })

    const got = await mirror.read("shared")
    assert.equal(got.body, "new remote")
    assert.equal((await primary.read("shared")).body, "new remote")
  } finally {
    await cleanup()
  }
})

test("[mirror] list prefers newer duplicate summary", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "same", body: "old local" })
    await new Promise((r) => setTimeout(r, 10))
    await secondary.write({ id: "same", body: "new remote" })

    const [entry] = await mirror.list({ sort: "id-asc" })
    assert.equal(entry.preview, "new remote")
  } finally {
    await cleanup()
  }
})

test("[mirror] delete removes from both", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await mirror.write({ id: "x", body: "y" })
    await mirror.delete("x")
    await assert.rejects(() => primary.read("x"), ContextNotFoundError)
    await assert.rejects(() => secondary.read("x"), ContextNotFoundError)
  } finally {
    await cleanup()
  }
})

test("[mirror] secondary write failure does not break primary write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-mirror-prim-"))
  const primary = new LocalBackend({ rootDir: dir })
  await primary.init()
  // Stub secondary that always throws on write — verifies that mirror swallows
  // the failure and still returns the primary's saved entry.
  const failures: string[] = []
  const secondary: any = {
    describe: () => ({ type: "stub", label: "stub", capabilities: { history: false } }),
    init: async () => {},
    read: async () => { throw new ContextNotFoundError("x") },
    write: async () => { throw new Error("network down") },
    delete: async () => {},
    list: async () => [],
    search: async () => [],
    listTags: async () => [],
  }
  const mirror = new MirrorBackend({
    primary,
    secondary,
    onSecondaryError: (op, e) => failures.push(`${op}: ${e.message}`),
  })
  try {
    const saved = await mirror.write({ id: "a", body: "b" })
    assert.equal(saved.body, "b")
    assert.equal((await primary.read("a")).body, "b")
    assert.ok(failures.some((f) => f.includes("network down")), `expected onSecondaryError to fire; got ${failures.join(", ")}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
