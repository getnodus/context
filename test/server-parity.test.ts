import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpBackend, LocalBackend } from "../src/backends/index.js"
import { filterAcked, isAcked } from "../src/backends/health.js"
import { startStubServer } from "./stub-server.js"

async function setupHttpPair(): Promise<{
  client: HttpBackend
  server: LocalBackend
  close: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), "ctx-srv-parity-"))
  const server = new LocalBackend({ rootDir: dir })
  await server.init()
  const { url, close } = await startStubServer(server)
  const client = new HttpBackend({ url })
  return {
    client,
    server,
    close: async () => {
      await close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("server-side verifyAccepted: round-trips through PUT/GET", async () => {
  const { client, server, close } = await setupHttpPair()
  try {
    await client.write({
      id: "ref/silenced",
      body: "x",
      verify: { kind: "repo", target: "old/repo" },
      verifyStatus: "failed",
      verifyMessage: "archived",
      verifyAccepted: true,
      verifyAcceptedAt: "2026-05-01T00:00:00.000Z",
      verifyAcceptedReason: "kept for history",
    })
    const remote = await server.read("ref/silenced")
    assert.equal(remote.verifyAccepted, true, "server persisted verifyAccepted")
    assert.equal(remote.verifyAcceptedReason, "kept for history")
    const round = await client.read("ref/silenced")
    assert.equal(round.verifyAccepted, true, "client sees verifyAccepted on read")
    assert.equal(round.verifyAcceptedReason, "kept for history")
  } finally {
    await close()
  }
})

test("server-side verify-on-write: runs verify when client sends a verify block without status", async () => {
  const { client, server, close } = await setupHttpPair()
  try {
    // path verify against a path that doesn't exist — server should stamp failed.
    await client.write({
      id: "ref/missing",
      body: "x",
      verify: { kind: "path", target: "/definitely/does/not/exist/abc123" },
    })
    const stored = await server.read("ref/missing")
    assert.equal(stored.verifyStatus, "failed", "server stamped failed status")
    assert.ok(stored.verifiedAt, "server stamped verifiedAt")
    assert.ok(stored.confirmations && stored.confirmations.length >= 1, "server logged a confirmation")
    assert.equal(stored.confirmations![0].method, "verify")
  } finally {
    await close()
  }
})

test("server-side verify-on-write: does NOT re-verify when client already stamped", async () => {
  const { client, server, close } = await setupHttpPair()
  try {
    // Client stamps verifyStatus=ok with a clearly fake verifiedAt; if the
    // server re-ran, it would FLIP this to failed (since the path is fake).
    const at = "2020-01-01T00:00:00.000Z"
    await client.write({
      id: "ref/preverified",
      body: "x",
      verify: { kind: "path", target: "/definitely/does/not/exist/abc123" },
      verifyStatus: "ok",
      verifiedAt: at,
    })
    const stored = await server.read("ref/preverified")
    assert.equal(stored.verifyStatus, "ok", "server preserved client status")
    assert.equal(stored.verifiedAt, at, "server preserved client timestamp")
  } finally {
    await close()
  }
})

test("HttpBackend.health: hits /health endpoint, returns server-computed audit", async () => {
  const { client, server, close } = await setupHttpPair()
  try {
    // Write an entry with a never-run verify so it's surfaced in health.
    await server.write({
      id: "ref/never",
      body: "x",
      verify: { kind: "url", target: "https://example.com" },
    })
    const health = await client.health()
    assert.equal(health.totalEntries, 1)
    assert.equal(health.neverVerified.length, 1)
    assert.equal(health.neverVerified[0].id, "ref/never")
    assert.equal(health.neverVerified[0].key, "never:ref/never")
  } finally {
    await close()
  }
})

test("isAcked: respects 7-day TTL", () => {
  const now = Date.now()
  const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const expired = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  assert.equal(isAcked({ "failed:foo": recent }, "failed:foo", now), true)
  assert.equal(isAcked({ "failed:foo": expired }, "failed:foo", now), false)
  assert.equal(isAcked({}, "failed:foo", now), false)
  assert.equal(isAcked(undefined, "failed:foo", now), false)
})

test("filterAcked: removes acknowledged issues, leaves others", () => {
  const now = Date.now()
  const fresh = new Date(now - 1000 * 60).toISOString()
  const health = {
    totalEntries: 3,
    failedVerifies: [
      { id: "a", title: "", type: "fact", tags: [], created: "", updated: "", preview: "", key: "failed:a" },
      { id: "b", title: "", type: "fact", tags: [], created: "", updated: "", preview: "", key: "failed:b" },
    ],
    neverVerified: [],
    staleVerifies: [],
    duplicateClusters: [{ ids: ["c", "d"], overlap: 0.7, key: "dup:c|d" }],
    issueCount: 3,
  }
  const filtered = filterAcked(health, { "failed:a": fresh, "dup:c|d": fresh }, now)
  assert.equal(filtered.failedVerifies.length, 1)
  assert.equal(filtered.failedVerifies[0].id, "b")
  assert.equal(filtered.duplicateClusters.length, 0)
  assert.equal(filtered.issueCount, 1)
})
