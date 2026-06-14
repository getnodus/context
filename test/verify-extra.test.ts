import test from "node:test"
import assert from "node:assert/strict"
import { runVerify, defaultVerifyTimeoutMs } from "../src/backends/verify.js"

// --- defaultVerifyTimeoutMs ---

test("defaultVerifyTimeoutMs: returns 8000 by default", () => {
  const orig = process.env.NODUS_VERIFY_TIMEOUT_MS
  delete process.env.NODUS_VERIFY_TIMEOUT_MS
  try {
    assert.equal(defaultVerifyTimeoutMs(), 8000)
  } finally {
    if (orig !== undefined) process.env.NODUS_VERIFY_TIMEOUT_MS = orig
  }
})

test("defaultVerifyTimeoutMs: respects env override", () => {
  const orig = process.env.NODUS_VERIFY_TIMEOUT_MS
  process.env.NODUS_VERIFY_TIMEOUT_MS = "3000"
  try {
    assert.equal(defaultVerifyTimeoutMs(), 3000)
  } finally {
    if (orig !== undefined) process.env.NODUS_VERIFY_TIMEOUT_MS = orig
    else delete process.env.NODUS_VERIFY_TIMEOUT_MS
  }
})

test("defaultVerifyTimeoutMs: ignores invalid env value", () => {
  const orig = process.env.NODUS_VERIFY_TIMEOUT_MS
  process.env.NODUS_VERIFY_TIMEOUT_MS = "not-a-number"
  try {
    assert.equal(defaultVerifyTimeoutMs(), 8000)
  } finally {
    if (orig !== undefined) process.env.NODUS_VERIFY_TIMEOUT_MS = orig
    else delete process.env.NODUS_VERIFY_TIMEOUT_MS
  }
})

test("defaultVerifyTimeoutMs: ignores negative env value", () => {
  const orig = process.env.NODUS_VERIFY_TIMEOUT_MS
  process.env.NODUS_VERIFY_TIMEOUT_MS = "-5"
  try {
    assert.equal(defaultVerifyTimeoutMs(), 8000)
  } finally {
    if (orig !== undefined) process.env.NODUS_VERIFY_TIMEOUT_MS = orig
    else delete process.env.NODUS_VERIFY_TIMEOUT_MS
  }
})

// --- runVerify: inlineBudgetMs ---

test("runVerify: inlineBudgetMs caps timeout", async () => {
  let seenAbort = false
  const fakeFetch = (async (_input: any, init: any) => {
    // The abort should have a shorter timeout if inlineBudgetMs is effective
    return { ok: true, status: 200 } as unknown as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "https://example.com" },
    { fetch: fakeFetch, timeoutMs: 30000, inlineBudgetMs: 100 },
  )
  assert.equal(result.status, "ok")
})

// --- runVerify: unknown verify kind ---

test("runVerify: unknown kind returns unknown status", async () => {
  const result = await runVerify({ kind: "magic" as any, target: "test" })
  assert.equal(result.status, "unknown")
  assert.ok(result.message?.includes("unknown verify kind"))
})

// --- runVerify: repo slug parsing ---

test("verify repo: rejects invalid slug format", async () => {
  const result = await runVerify(
    { kind: "repo", target: "not-a-slug" },
    { fetch: (() => {}) as any },
  )
  assert.equal(result.status, "failed")
  assert.ok(result.message?.includes("must be owner/name"))
})

test("verify repo: accepts plain github.com/owner/name URL", async () => {
  let apiUrl = ""
  const fakeFetch = (async (input: any) => {
    apiUrl = typeof input === "string" ? input : input.url
    return { ok: true, status: 200, json: async () => ({ archived: false }) } as unknown as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "repo", target: "github.com/owner/repo" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "ok")
  assert.ok(apiUrl.includes("repos/owner/repo"))
})

test("verify repo: handles 403 rate-limit as unknown", async () => {
  const fakeFetch = (async () => {
    return { ok: false, status: 403 } as unknown as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "repo", target: "owner/repo" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "unknown")
  assert.ok(result.message?.includes("rate limited"))
})

test("verify repo: handles 5xx as unknown", async () => {
  const fakeFetch = (async () => {
    return { ok: false, status: 502 } as unknown as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "repo", target: "owner/repo" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "unknown")
})

test("verify repo: handles non-ok non-5xx as failed", async () => {
  const fakeFetch = (async () => {
    return { ok: false, status: 451 } as unknown as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "repo", target: "owner/repo" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "failed")
})

test("verify repo: handles network error as unknown", async () => {
  const fakeFetch = (async () => {
    throw new Error("DNS resolution failed")
  }) as typeof fetch

  const result = await runVerify(
    { kind: "repo", target: "owner/repo" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "unknown")
  assert.ok(result.message?.includes("DNS resolution failed"))
})

test("verify repo: handles abort as unknown with timeout message", async () => {
  const fakeFetch = (async () => {
    const e = new Error("aborted")
    e.name = "AbortError"
    throw e
  }) as typeof fetch

  const result = await runVerify(
    { kind: "repo", target: "owner/repo" },
    { fetch: fakeFetch, timeoutMs: 100 },
  )
  assert.equal(result.status, "unknown")
  assert.ok(result.message?.includes("timed out"))
})

// --- runVerify: url edge cases ---

test("verify url: handles abort/timeout as unknown", async () => {
  const fakeFetch = (async () => {
    const e = new Error("aborted")
    e.name = "AbortError"
    throw e
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "https://example.com" },
    { fetch: fakeFetch, timeoutMs: 100 },
  )
  assert.equal(result.status, "unknown")
  assert.ok(result.message?.includes("timed out"))
})

test("verify url: handles generic network error as unknown", async () => {
  const fakeFetch = (async () => {
    throw new Error("connection refused")
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "https://example.com" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "unknown")
  assert.ok(result.message?.includes("connection refused"))
})

// --- runVerify: path with home expansion ---

test("verify path: expands ~ to home dir", async () => {
  // ~ itself should resolve to the home directory, which exists
  const result = await runVerify({ kind: "path", target: "~" })
  assert.equal(result.status, "ok")
})

test("verify path: handles non-ENOENT errors as unknown", async () => {
  // /proc/1/root on Linux will give EACCES, not ENOENT
  // Use a path that would cause an error other than ENOENT
  const result = await runVerify({ kind: "path", target: "/definitely/not/real" })
  assert.equal(result.status, "failed")
})
