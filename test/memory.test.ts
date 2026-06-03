import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalBackend } from "../src/backends/index.js"
import { recallContext, rememberContext } from "../src/memory.js"

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-memory-"))
  const backend = new LocalBackend({ rootDir: dir })
  await backend.init()
  return {
    backend,
    cleanup: async () => {
      await backend.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("rememberContext infers id/type/tags from natural language", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "User prefers terse engineering answers.",
      author: "test-agent",
    })

    assert.equal(result.action, "created")
    assert.equal(result.entry.type, "preference")
    assert.equal(result.entry.id, "preferences/prefers-terse-engineering-answers")
    assert.deepEqual(result.entry.tags, ["global", "preference"])
    assert.equal(result.entry.author, "test-agent")
  } finally {
    await cleanup()
  }
})

test("recallContext searches memories through the simple read path", async () => {
  const { backend, cleanup } = await setup()
  try {
    await rememberContext(backend, { text: "Always use mirror mode for shared context servers." })

    const result = await recallContext(backend, { query: "mirror servers" })

    assert.equal(result.count, 1)
    assert.equal(result.hits?.[0]?.entry.type, "rule")
  } finally {
    await cleanup()
  }
})
