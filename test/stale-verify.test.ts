import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalBackend } from "../src/backends/index.js"
import type { VerifySpec } from "../src/backends/index.js"
import type { VerifyResult } from "../src/backends/verify.js"

interface VerifierCall {
  spec: VerifySpec
}

function recordingVerifier(result: VerifyResult): {
  fn: (spec: VerifySpec) => Promise<VerifyResult>
  calls: VerifierCall[]
} {
  const calls: VerifierCall[] = []
  return {
    calls,
    fn: async (spec) => {
      calls.push({ spec })
      return result
    },
  }
}

async function flushBackground(backend: LocalBackend): Promise<void> {
  await backend.flushBackgroundWork()
}

test("background verify: triggers on stale entry, writes back result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-staleverify-"))
  const { fn: verifier, calls } = recordingVerifier({
    status: "failed",
    message: "archived",
  })
  try {
    const backend = new LocalBackend({ rootDir: dir, backgroundVerify: true, verifier })
    await backend.init()
    await backend.write({
      id: "ref/old",
      body: "x",
      verify: { kind: "repo", target: "org/old" },
      verifyStatus: "ok",
      verifiedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    })

    await backend.read("ref/old")
    await flushBackground(backend)

    assert.equal(calls.length, 1, "verifier ran exactly once")
    const after = await backend.read("ref/old")
    assert.equal(after.verifyStatus, "failed")
    assert.equal(after.verifyMessage, "archived")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("background verify: skips fresh entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-staleverify-fresh-"))
  const { fn: verifier, calls } = recordingVerifier({ status: "ok" })
  try {
    const backend = new LocalBackend({ rootDir: dir, backgroundVerify: true, verifier })
    await backend.init()
    await backend.write({
      id: "ref/fresh",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifyStatus: "ok",
      verifiedAt: new Date().toISOString(),
    })

    await backend.read("ref/fresh")
    await flushBackground(backend)

    assert.equal(calls.length, 0, "verifier did not run for fresh entry")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("background verify: disabled by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-staleverify-off-"))
  const { fn: verifier, calls } = recordingVerifier({ status: "ok" })
  try {
    const backend = new LocalBackend({ rootDir: dir, verifier })
    await backend.init()
    await backend.write({
      id: "ref/old",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifiedAt: new Date(0).toISOString(),
    })

    await backend.read("ref/old")
    await flushBackground(backend)

    assert.equal(calls.length, 0, "verifier did not run when backgroundVerify is off")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("background verify: deduplicates concurrent reads of the same id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-staleverify-dedup-"))
  let calls = 0
  const slowVerifier = async (): Promise<VerifyResult> => {
    calls++
    await new Promise((r) => setTimeout(r, 25))
    return { status: "ok" }
  }
  try {
    const backend = new LocalBackend({
      rootDir: dir,
      backgroundVerify: true,
      verifier: slowVerifier,
    })
    await backend.init()
    await backend.write({
      id: "ref/old",
      body: "x",
      verify: { kind: "url", target: "https://x" },
      verifiedAt: new Date(0).toISOString(),
    })

    await Promise.all([backend.read("ref/old"), backend.read("ref/old"), backend.read("ref/old")])
    await flushBackground(backend)
    await new Promise((r) => setTimeout(r, 60))

    assert.equal(calls, 1, "only one verifier ran despite three concurrent reads")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
