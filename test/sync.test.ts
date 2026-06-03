import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalBackend } from "../src/backends/index.js"
import { reconcileBackends, syncBackends } from "../src/sync.js"

async function setupPair() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-sync-"))
  const a = new LocalBackend({ rootDir: join(dir, "a") })
  const b = new LocalBackend({ rootDir: join(dir, "b") })
  await a.init()
  await b.init()
  return {
    a,
    b,
    cleanup: async () => {
      await a.close()
      await b.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("syncBackends preserves verify and confirmation metadata", async () => {
  const { a, b, cleanup } = await setupPair()
  try {
    await a.write({
      id: "ref/tool",
      body: "Tool reference",
      verify: { kind: "url", target: "https://example.com" },
      verifyStatus: "ok",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      confirmations: [{ by: "agent-a", at: "2026-01-01T00:00:00.000Z", method: "verify" }],
    })

    const result = await syncBackends(a, b)
    const copied = await b.read("ref/tool")

    assert.equal(result.copied, 1)
    assert.equal(copied.verifyStatus, "ok")
    assert.equal(copied.verifiedAt, "2026-01-01T00:00:00.000Z")
    assert.equal(copied.confirmations?.[0]?.by, "agent-a")
  } finally {
    await cleanup()
  }
})

test("reconcileBackends copies entries both ways", async () => {
  const { a, b, cleanup } = await setupPair()
  try {
    await a.write({ id: "local/only", body: "local" })
    await b.write({ id: "remote/only", body: "remote" })

    const result = await reconcileBackends(a, b)

    assert.equal(result.forward.copied, 1)
    assert.equal(result.backward.copied, 1)
    assert.equal((await a.read("remote/only")).body, "remote")
    assert.equal((await b.read("local/only")).body, "local")
  } finally {
    await cleanup()
  }
})
