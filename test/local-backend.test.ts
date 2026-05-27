import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LocalBackend,
  InvalidIdError,
  BodyTooLargeError,
  MAX_BODY_BYTES,
} from "../src/backends/index.js"
import { runConformance } from "./conformance.js"

async function setupLocal() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-local-"))
  const backend = new LocalBackend({ rootDir: dir })
  await backend.init()
  return {
    backend,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

runConformance("local", setupLocal)

// Local-specific tests
test("[local] invalid ids are rejected", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    for (const bad of ["../escape", "/abs", "has space", "trailing/", "/leading", "double//slash"]) {
      await assert.rejects(
        () => backend.write({ id: bad, body: "x" }),
        InvalidIdError,
        `expected reject for ${bad}`,
      )
    }
  } finally {
    await cleanup()
  }
})

test("[local] oversized body is rejected", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    const big = "x".repeat(MAX_BODY_BYTES + 1)
    await assert.rejects(
      () => backend.write({ id: "big/one", body: big }),
      BodyTooLargeError,
    )
  } finally {
    await cleanup()
  }
})

test("[local] overwrite preserves created and snapshots previous", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    const first = await backend.write({ id: "user/identity", body: "v1" })
    await new Promise((r) => setTimeout(r, 10))
    const second = await backend.write({ id: "user/identity", body: "v2" })

    assert.equal(second.created, first.created)
    assert.notEqual(second.updated, first.updated)

    const history = await backend.listHistory!("user/identity")
    assert.equal(history.length, 1)
    assert.equal(history[0].deletion, false)

    const snap = await backend.readSnapshot!("user/identity", history[0].file)
    assert.equal(snap.body, "v1")
  } finally {
    await cleanup()
  }
})

test("[local] delete snapshots before removing", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    await backend.write({ id: "tmp/note", body: "soon to vanish" })
    await backend.delete("tmp/note")

    const history = await backend.listHistory!("tmp/note")
    assert.equal(history.length, 1)
    assert.equal(history[0].deletion, true)
  } finally {
    await cleanup()
  }
})

test("[local] revert restores latest snapshot", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    await backend.write({ id: "user/identity", body: "v1" })
    await new Promise((r) => setTimeout(r, 10))
    await backend.write({ id: "user/identity", body: "v2" })

    const reverted = await backend.revert!("user/identity")
    assert.equal(reverted.body, "v1")
  } finally {
    await cleanup()
  }
})

test("[local] frontmatter on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-fm-"))
  try {
    const backend = new LocalBackend({ rootDir: dir })
    await backend.init()
    await backend.write({ id: "user/identity", body: "Hello", tags: ["a", "b"] })
    const raw = await readFile(join(dir, "user", "identity.md"), "utf8")
    assert.match(raw, /^---/)
    assert.match(raw, /id: user\/identity/)
    assert.match(raw, /\nHello/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("[local] describe reports correct type and capabilities", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    const d = backend.describe()
    assert.equal(d.type, "local")
    assert.equal(d.capabilities.history, true)
    assert.equal(d.capabilities.useTracking, true)
  } finally {
    await cleanup()
  }
})

test("[local] read increments use count", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    await backend.write({ id: "user/identity", body: "Fischer" })
    const r1 = await backend.read("user/identity")
    assert.equal(r1.useCount, 1)
    assert.ok(r1.lastUsedAt)

    const r2 = await backend.read("user/identity")
    assert.equal(r2.useCount, 2)

    await backend.close?.()
  } finally {
    await cleanup()
  }
})

test("[local] list surfaces use counts", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    await backend.write({ id: "a", body: "x" })
    await backend.write({ id: "b", body: "x" })
    await backend.read("a")
    await backend.read("a")
    await backend.read("b")
    await backend.close?.()

    const list = await backend.list()
    const a = list.find((e) => e.id === "a")
    const b = list.find((e) => e.id === "b")
    assert.equal(a?.useCount, 2)
    assert.equal(b?.useCount, 1)
  } finally {
    await cleanup()
  }
})

test("[local] delete clears use tracking", async () => {
  const { backend, cleanup } = await setupLocal()
  try {
    await backend.write({ id: "tmp/note", body: "x" })
    await backend.read("tmp/note")
    await backend.delete("tmp/note")
    await backend.write({ id: "tmp/note", body: "x" })
    const fresh = await backend.read("tmp/note")
    assert.equal(fresh.useCount, 1, "use count restarts after delete")
  } finally {
    await cleanup()
  }
})
