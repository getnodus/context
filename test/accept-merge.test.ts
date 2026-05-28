import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalBackend } from "../src/backends/index.js"
import {
  computeMemoryHealth,
  filterForBrief,
  renderHealthHeadline,
  entryHealthMarker,
} from "../src/backends/health.js"
import { computeConfidence } from "../src/backends/confidence.js"

async function newBackend() {
  const dir = await mkdtemp(join(tmpdir(), "ctx-accept-"))
  const backend = new LocalBackend({ rootDir: dir })
  await backend.init()
  return { backend, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("verifyAccepted: round-trips through write/read", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await backend.write({
      id: "ref/archived",
      body: "old archived repo",
      verify: { kind: "repo", target: "org/archived" },
      verifyStatus: "failed",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      verifyMessage: "archived",
      verifyAccepted: true,
      verifyAcceptedAt: "2026-05-01T00:00:00.000Z",
      verifyAcceptedReason: "intentionally archived",
    })
    const e = await backend.read("ref/archived")
    assert.equal(e.verifyAccepted, true)
    assert.equal(e.verifyAcceptedAt, "2026-05-01T00:00:00.000Z")
    assert.equal(e.verifyAcceptedReason, "intentionally archived")
  } finally {
    await cleanup()
  }
})

test("verifyAccepted: auto-clears when verify later passes", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await backend.write({
      id: "ref/x",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifyStatus: "failed",
      verifyAccepted: true,
    })
    // Verify later passes — no point in suppressing a passing entry.
    await backend.write({
      id: "ref/x",
      body: "x",
      verifyStatus: "ok",
      verifiedAt: new Date().toISOString(),
    })
    const e = await backend.read("ref/x")
    assert.equal(e.verifyStatus, "ok")
    assert.equal(e.verifyAccepted, undefined)
  } finally {
    await cleanup()
  }
})

test("health: accepted entries go to acceptedVerifies bucket, not failed", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await backend.write({
      id: "ref/silenced",
      body: "x",
      verify: { kind: "repo", target: "old/repo" },
      verifyStatus: "failed",
      verifyMessage: "archived",
      verifyAccepted: true,
    })
    await backend.write({
      id: "ref/loud",
      body: "x",
      verify: { kind: "repo", target: "broken/repo" },
      verifyStatus: "failed",
      verifyMessage: "404",
    })
    const health = await computeMemoryHealth(backend)
    assert.equal(health.failedVerifies.length, 1)
    assert.equal(health.failedVerifies[0].id, "ref/loud")
    assert.equal(health.acceptedVerifies.length, 1)
    assert.equal(health.acceptedVerifies[0].id, "ref/silenced")
    assert.equal(health.urgency.urgent, 1)
  } finally {
    await cleanup()
  }
})

test("confidence: accepted failed verify → medium (not low)", () => {
  assert.equal(
    computeConfidence({ verifyStatus: "failed", verifyAccepted: true }),
    "medium",
  )
  assert.equal(computeConfidence({ verifyStatus: "failed" }), "low")
})

test("urgency split: failed counts urgent; never/stale/dup count informational", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    const now = new Date()
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    await backend.write({
      id: "ref/failed",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifyStatus: "failed",
    })
    await backend.write({
      id: "ref/never",
      body: "x",
      verify: { kind: "url", target: "https://y" },
    })
    await backend.write({
      id: "ref/stale",
      body: "x",
      verify: { kind: "url", target: "https://z" },
      verifyStatus: "ok",
      verifiedAt: old,
    })
    const health = await computeMemoryHealth(backend, { now: now.getTime() })
    assert.equal(health.urgency.urgent, 1)
    assert.ok(health.urgency.informational >= 2)
  } finally {
    await cleanup()
  }
})

test("freshStore: every entry created in the last 24h flips the flag", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await backend.write({ id: "user/a", body: "a" })
    await backend.write({ id: "user/b", body: "b" })
    const health = await computeMemoryHealth(backend)
    assert.equal(health.freshStore, true)
  } finally {
    await cleanup()
  }
})

test("filterForBrief: never-checked entries are hidden on a fresh store", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    // All entries created right now → fresh store
    await backend.write({
      id: "ref/needs-check",
      body: "x",
      verify: { kind: "url", target: "https://x" },
    })
    const health = await computeMemoryHealth(backend)
    assert.equal(health.neverVerified.length, 1, "audit sees it")
    const briefed = filterForBrief(health)
    assert.equal(briefed.neverVerified.length, 0, "brief hides it on fresh install")
  } finally {
    await cleanup()
  }
})

test("entryHealthMarker: warns failed but-not-accepted, never-checked", async () => {
  assert.equal(entryHealthMarker({ verifyStatus: "failed" } as any), "⚠")
  assert.equal(entryHealthMarker({ verifyStatus: "failed", verifyAccepted: true } as any), null)
  assert.equal(
    entryHealthMarker({ verify: { kind: "url", target: "x" } } as any),
    "◐",
  )
  assert.equal(
    entryHealthMarker({
      verify: { kind: "url", target: "x" },
      verifiedAt: "2026-01-01",
      verifyStatus: "ok",
    } as any),
    null,
  )
})

test("renderHealthHeadline: separates urgent from informational", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await backend.write({
      id: "ref/a",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifyStatus: "failed",
    })
    await backend.write({
      id: "ref/b",
      body: "x",
      verify: { kind: "url", target: "https://y" },
    })
    const health = await computeMemoryHealth(backend)
    const line = renderHealthHeadline(health)
    assert.match(line, /failed/)
    assert.match(line, /never checked/)
    // Urgent and informational are visually separated by " · (...)"
    assert.match(line, /\(.*never checked.*\)/)
  } finally {
    await cleanup()
  }
})

test("confirmations dedup: same agent same day collapses; cap honored", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    const at = (h: number) => `2026-05-28T${String(h).padStart(2, "0")}:00:00.000Z`
    await backend.write({
      id: "x",
      body: "x",
      confirmations: [
        { by: "claude-code/1.0", at: at(1), method: "use" },
        { by: "claude-code/1.1", at: at(2), method: "use" }, // same agent, same day → dedup
        { by: "cursor/1", at: at(3), method: "use" }, // distinct agent → keep
        { by: "claude-code/1.2", at: at(4), method: "verify" }, // newer same-agent same-day → wins
      ],
    })
    const e = await backend.read("x")
    assert.equal(e.confirmations?.length, 2, "deduped to one per agent per day")
    const claudeConf = e.confirmations?.find((c) => c.by.startsWith("claude-code"))
    assert.equal(claudeConf?.at, at(4), "most recent kept")
  } finally {
    await cleanup()
  }
})

test("confirmations cap: cannot exceed 12 entries", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    // 20 distinct agents on distinct days — should cap to 12 most recent.
    const confs = Array.from({ length: 20 }, (_, i) => ({
      by: `agent-${i}`,
      at: `2026-${String(Math.floor(i / 30) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      method: "use" as const,
    }))
    await backend.write({ id: "x", body: "x", confirmations: confs })
    const e = await backend.read("x")
    assert.ok(e.confirmations!.length <= 12, `got ${e.confirmations!.length}, expected ≤ 12`)
  } finally {
    await cleanup()
  }
})
