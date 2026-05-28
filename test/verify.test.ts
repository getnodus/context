import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runVerify } from "../src/backends/verify.js"
import { LocalBackend } from "../src/backends/index.js"
import { computeConfidence } from "../src/backends/confidence.js"

function fakeFetch(handler: (url: string) => { status: number; body?: unknown }): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const { status, body } = handler(url)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      async json() {
        return body ?? {}
      },
      async text() {
        return JSON.stringify(body ?? {})
      },
    } as unknown as Response
  }) as typeof fetch
}

test("verify url: ok on 2xx", async () => {
  const result = await runVerify(
    { kind: "url", target: "https://example.com/foo" },
    { fetch: fakeFetch(() => ({ status: 200 })) },
  )
  assert.equal(result.status, "ok")
})

test("verify url: failed on 404", async () => {
  const result = await runVerify(
    { kind: "url", target: "https://example.com/missing" },
    { fetch: fakeFetch(() => ({ status: 404 })) },
  )
  assert.equal(result.status, "failed")
  assert.match(result.message ?? "", /404/)
})

test("verify url: unknown on 5xx (transient)", async () => {
  const result = await runVerify(
    { kind: "url", target: "https://example.com/x" },
    { fetch: fakeFetch(() => ({ status: 503 })) },
  )
  assert.equal(result.status, "unknown")
})

test("verify url: rejects non-http target", async () => {
  const result = await runVerify({ kind: "url", target: "ftp://x" })
  assert.equal(result.status, "failed")
})

test("verify repo: failed when archived", async () => {
  const result = await runVerify(
    { kind: "repo", target: "getnodus/old" },
    {
      fetch: fakeFetch((url) => {
        assert.match(url, /api\.github\.com\/repos\/getnodus\/old/)
        return { status: 200, body: { archived: true } }
      }),
    },
  )
  assert.equal(result.status, "failed")
  assert.match(result.message ?? "", /archived/)
})

test("verify repo: ok when not archived", async () => {
  const result = await runVerify(
    { kind: "repo", target: "getnodus/active" },
    { fetch: fakeFetch(() => ({ status: 200, body: { archived: false } })) },
  )
  assert.equal(result.status, "ok")
})

test("verify repo: failed on 404", async () => {
  const result = await runVerify(
    { kind: "repo", target: "missing/repo" },
    { fetch: fakeFetch(() => ({ status: 404 })) },
  )
  assert.equal(result.status, "failed")
})

test("verify repo: accepts github.com URL form", async () => {
  let seen = ""
  await runVerify(
    { kind: "repo", target: "https://github.com/getnodus/context.git" },
    {
      fetch: fakeFetch((url) => {
        seen = url
        return { status: 200, body: { archived: false } }
      }),
    },
  )
  assert.match(seen, /repos\/getnodus\/context$/)
})

test("verify path: ok when file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-path-"))
  const file = join(dir, "exists.txt")
  await writeFile(file, "x")
  try {
    const result = await runVerify({ kind: "path", target: file })
    assert.equal(result.status, "ok")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("verify path: failed when missing", async () => {
  const result = await runVerify({ kind: "path", target: "/definitely/not/real/path/abc123" })
  assert.equal(result.status, "failed")
})

test("local backend round-trips verify block and confirmations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-verify-"))
  try {
    const backend = new LocalBackend({ rootDir: dir })
    await backend.init()
    await backend.write({
      id: "ref/nodus",
      body: "the repo",
      verify: { kind: "repo", target: "getnodus/context" },
      verifiedAt: "2025-01-01T00:00:00.000Z",
      verifyStatus: "ok",
      confirmations: [{ by: "claude-code", at: "2025-01-01T00:00:00.000Z", method: "verify" }],
    })
    const read = await backend.read("ref/nodus")
    assert.deepEqual(read.verify, { kind: "repo", target: "getnodus/context" })
    assert.equal(read.verifyStatus, "ok")
    assert.equal(read.verifiedAt, "2025-01-01T00:00:00.000Z")
    assert.equal(read.confirmations?.length, 1)
    assert.equal(read.confirmations?.[0].method, "verify")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("computeConfidence: failed verify → low", () => {
  assert.equal(computeConfidence({ verifyStatus: "failed" }), "low")
})

test("computeConfidence: ok + recent verify → high", () => {
  const now = Date.now()
  assert.equal(
    computeConfidence({
      verifyStatus: "ok",
      verifiedAt: new Date(now - 1000 * 60 * 60).toISOString(),
    }),
    "high",
  )
})

test("computeConfidence: ok + old verify → medium", () => {
  const now = Date.now()
  assert.equal(
    computeConfidence({
      verifyStatus: "ok",
      verifiedAt: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    "medium",
  )
})

test("computeConfidence: has verify spec but never run → low (prompts to verify)", () => {
  assert.equal(
    computeConfidence({ verify: { kind: "url", target: "https://x" } }),
    "low",
  )
})

test("computeConfidence: no signals at all → medium", () => {
  assert.equal(computeConfidence({}), "medium")
})

test("search hits carry confidence; failed-verify entry is low", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-conf-"))
  try {
    const backend = new LocalBackend({ rootDir: dir })
    await backend.init()
    await backend.write({
      id: "ref/archived",
      body: "old archived repo amsterdam",
      verify: { kind: "repo", target: "getnodus/archived" },
      verifyStatus: "failed",
      verifiedAt: new Date().toISOString(),
      verifyMessage: "repo is archived",
    })
    await backend.write({
      id: "ref/active",
      body: "the active project amsterdam",
      verify: { kind: "repo", target: "getnodus/active" },
      verifyStatus: "ok",
      verifiedAt: new Date().toISOString(),
    })
    const hits = await backend.search("amsterdam")
    const archived = hits.find((h) => h.entry.id === "ref/archived")
    const active = hits.find((h) => h.entry.id === "ref/active")
    assert.equal(archived?.confidence, "low")
    assert.equal(active?.confidence, "high")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
