import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBackend } from "../src/backends/factory.js"

test("createBackend: creates a local backend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-test-"))
  try {
    const backend = await createBackend({ type: "local", rootDir: dir })
    const desc = backend.describe()
    assert.equal(desc.type, "local")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("createBackend: creates an http backend", async () => {
  const backend = await createBackend({ type: "http", url: "http://localhost:9999" })
  const desc = backend.describe()
  assert.equal(desc.type, "http")
})

test("createBackend: creates a mirror backend", async () => {
  const a = await mkdtemp(join(tmpdir(), "factory-mirror-a-"))
  const b = await mkdtemp(join(tmpdir(), "factory-mirror-b-"))
  try {
    const backend = await createBackend({
      type: "mirror",
      primary: { type: "local", rootDir: a },
      secondary: { type: "local", rootDir: b },
    })
    const desc = backend.describe()
    assert.equal(desc.type, "mirror")
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test("createBackend: passes backgroundVerify to local backend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-bgv-"))
  try {
    const backend = await createBackend(
      { type: "local", rootDir: dir },
      { backgroundVerify: true },
    )
    assert.equal(backend.describe().type, "local")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("createBackend: throws on unknown backend type", async () => {
  await assert.rejects(
    () => createBackend({ type: "unknown" } as any),
    /unknown backend type/,
  )
})
