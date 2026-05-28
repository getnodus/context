import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalBackend } from "../src/backends/index.js"
import {
  computeMemoryHealth,
  renderHealthBullets,
  renderHealthHeadline,
} from "../src/backends/health.js"
import { computeConfidence } from "../src/backends/confidence.js"

async function newBackend() {
  const dir = await mkdtemp(join(tmpdir(), "ctx-health-"))
  const backend = new LocalBackend({ rootDir: dir })
  await backend.init()
  return { backend, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("computeMemoryHealth: surfaces failed/never/stale buckets", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    const now = new Date()
    const oldVerify = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const recentVerify = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString()

    await backend.write({
      id: "ref/archived",
      body: "old repo",
      verify: { kind: "repo", target: "org/archived" },
      verifyStatus: "failed",
      verifiedAt: recentVerify,
      verifyMessage: "archived",
    })
    await backend.write({
      id: "ref/never",
      body: "never checked",
      verify: { kind: "url", target: "https://example.com" },
    })
    await backend.write({
      id: "ref/stale",
      body: "long ago",
      verify: { kind: "path", target: "/tmp" },
      verifyStatus: "ok",
      verifiedAt: oldVerify,
    })
    await backend.write({
      id: "ref/fresh",
      body: "good",
      verify: { kind: "path", target: "/tmp" },
      verifyStatus: "ok",
      verifiedAt: recentVerify,
    })

    const health = await computeMemoryHealth(backend, { now: now.getTime() })
    assert.equal(health.totalEntries, 4)
    assert.equal(health.failedVerifies.length, 1)
    assert.equal(health.failedVerifies[0].id, "ref/archived")
    assert.equal(health.neverVerified.length, 1)
    assert.equal(health.neverVerified[0].id, "ref/never")
    assert.equal(health.staleVerifies.length, 1)
    assert.equal(health.staleVerifies[0].id, "ref/stale")
    assert.ok(health.issueCount >= 3)
  } finally {
    await cleanup()
  }
})

test("computeMemoryHealth: finds near-duplicates across different ids", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await backend.write({
      id: "user/location",
      body: "Fischer lives in Amsterdam Netherlands",
      tags: ["location", "user"],
    })
    await backend.write({
      id: "user/where",
      body: "Fischer lives in Amsterdam Netherlands",
      tags: ["location", "user"],
    })
    await backend.write({
      id: "preferences/coffee",
      body: "loves espresso in the morning",
    })

    const health = await computeMemoryHealth(backend)
    assert.ok(
      health.duplicateClusters.length >= 1,
      "found at least one duplicate cluster",
    )
    const ids = new Set(health.duplicateClusters[0].ids)
    assert.ok(ids.has("user/location"))
    assert.ok(ids.has("user/where"))
  } finally {
    await cleanup()
  }
})

test("renderHealthBullets: hides stale when more urgent issues present", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    const now = new Date()
    const oldVerify = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    await backend.write({
      id: "ref/failed",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifyStatus: "failed",
      verifyMessage: "404",
      verifiedAt: now.toISOString(),
    })
    await backend.write({
      id: "ref/stale",
      body: "x",
      verify: { kind: "url", target: "https://y" },
      verifyStatus: "ok",
      verifiedAt: oldVerify,
    })
    const health = await computeMemoryHealth(backend, { now: now.getTime() })
    const bullets = renderHealthBullets(health)
    const text = bullets.join("\n")
    assert.match(text, /ref\/failed/)
    assert.doesNotMatch(text, /ref\/stale/, "stale is suppressed when failed is present")
  } finally {
    await cleanup()
  }
})

test("renderHealthHeadline: empty when no issues", () => {
  assert.equal(
    renderHealthHeadline({
      totalEntries: 5,
      failedVerifies: [],
      neverVerified: [],
      staleVerifies: [],
      duplicateClusters: [],
      issueCount: 0,
    }),
    "",
  )
})

test("confidence: ≥2 distinct confirmers in 30d → high", () => {
  const now = Date.now()
  const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()
  const c = computeConfidence(
    {
      confirmations: [
        { by: "claude-code/1", at: recent, method: "use" },
        { by: "cursor/2", at: recent, method: "use" },
      ],
    },
    now,
  )
  assert.equal(c, "high")
})

test("confidence: same agent twice does NOT count as corroboration", () => {
  const now = Date.now()
  const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()
  const c = computeConfidence(
    {
      confirmations: [
        { by: "claude-code/1", at: recent, method: "use" },
        { by: "claude-code/2", at: recent, method: "use" },
      ],
    },
    now,
  )
  assert.equal(c, "medium")
})

test("confidence: old confirmations don't count", () => {
  const now = Date.now()
  const old = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString()
  const c = computeConfidence(
    {
      confirmations: [
        { by: "claude-code", at: old, method: "use" },
        { by: "cursor", at: old, method: "use" },
      ],
    },
    now,
  )
  assert.equal(c, "medium")
})
