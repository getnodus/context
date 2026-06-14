import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalBackend } from "../src/backends/index.js"
import { recallContext, rememberContext } from "../src/memory.js"

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-memory-extra-"))
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

// --- inferType ---

test("rememberContext: infers rule type from 'never' keyword", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "Never use force push on main." })
    assert.equal(result.entry.type, "rule")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers rule type from 'always' keyword", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "Always run tests before merging." })
    assert.equal(result.entry.type, "rule")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers rule type from 'must' keyword", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "Code must pass lint checks." })
    assert.equal(result.entry.type, "rule")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers decision type", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "We decided to use TypeScript instead of JavaScript." })
    assert.equal(result.entry.type, "decision")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers gotcha type", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "Be careful with this API, it breaks on empty input." })
    assert.equal(result.entry.type, "gotcha")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers project-state type", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "Currently working on the auth module refactor." })
    assert.equal(result.entry.type, "project-state")
    assert.ok(result.inferred.scope === "project")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers reference type from URL", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "API docs at https://api.example.com/docs" })
    assert.equal(result.entry.type, "reference")
  } finally {
    await cleanup()
  }
})

test("rememberContext: infers fact as default type", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, { text: "Fischer is the founder of Nodus." })
    assert.equal(result.entry.type, "fact")
  } finally {
    await cleanup()
  }
})

// --- inferTitle ---

test("rememberContext: truncates long titles to 80 chars", async () => {
  const { backend, cleanup } = await setup()
  try {
    const longText = "A".repeat(200)
    const result = await rememberContext(backend, { text: longText })
    assert.ok(result.entry.title.length <= 80)
    assert.ok(result.entry.title.endsWith("..."))
  } finally {
    await cleanup()
  }
})

test("rememberContext: extracts title from first non-empty line", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "\n\n## Heading here\nSome body text.",
    })
    assert.equal(result.entry.title, "Heading here")
  } finally {
    await cleanup()
  }
})

// --- explicit overrides ---

test("rememberContext: respects explicit id override", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "Some fact about the system.",
      id: "custom/my-id",
    })
    assert.equal(result.entry.id, "custom/my-id")
  } finally {
    await cleanup()
  }
})

test("rememberContext: respects explicit type override", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "This looks like a fact but is really a gotcha.",
      type: "gotcha",
    })
    assert.equal(result.entry.type, "gotcha")
  } finally {
    await cleanup()
  }
})

test("rememberContext: respects explicit title override", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "The actual body text.",
      title: "Custom Title",
    })
    assert.equal(result.entry.title, "Custom Title")
  } finally {
    await cleanup()
  }
})

test("rememberContext: merges explicit tags with inferred tags", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "User likes dark mode.",
      tags: ["ui", "theme"],
    })
    assert.ok(result.entry.tags.includes("ui"))
    assert.ok(result.entry.tags.includes("theme"))
    assert.ok(result.entry.tags.includes("global"))
    assert.ok(result.entry.tags.includes("preference"))
  } finally {
    await cleanup()
  }
})

test("rememberContext: respects scope override", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "Fischer is the founder.",
      scope: "workspace",
    })
    assert.ok(result.entry.tags.includes("workspace"))
    assert.equal(result.inferred.scope, "workspace")
  } finally {
    await cleanup()
  }
})

// --- empty text ---

test("rememberContext: throws on empty text", async () => {
  const { backend, cleanup } = await setup()
  try {
    await assert.rejects(
      () => rememberContext(backend, { text: "" }),
      /text is empty/,
    )
  } finally {
    await cleanup()
  }
})

test("rememberContext: throws on whitespace-only text", async () => {
  const { backend, cleanup } = await setup()
  try {
    await assert.rejects(
      () => rememberContext(backend, { text: "   \n  " }),
      /text is empty/,
    )
  } finally {
    await cleanup()
  }
})

// --- recallContext ---

test("recallContext: lists recent entries without query", async () => {
  const { backend, cleanup } = await setup()
  try {
    await rememberContext(backend, { text: "First memory about testing." })
    await rememberContext(backend, { text: "Second memory about coding." })
    const result = await recallContext(backend, {})
    assert.equal(result.count, 2)
    assert.ok(result.entries)
    assert.ok(!result.hits)
  } finally {
    await cleanup()
  }
})

test("recallContext: respects limit", async () => {
  const { backend, cleanup } = await setup()
  try {
    await rememberContext(backend, { text: "Memory alpha." })
    await rememberContext(backend, { text: "Memory beta." })
    await rememberContext(backend, { text: "Memory gamma." })
    const result = await recallContext(backend, { limit: 1 })
    assert.equal(result.count, 1)
  } finally {
    await cleanup()
  }
})

test("recallContext: filters by scope tag", async () => {
  const { backend, cleanup } = await setup()
  try {
    await rememberContext(backend, { text: "Global note here.", scope: "global" })
    await rememberContext(backend, { text: "Currently working on tests.", scope: "project" })
    const result = await recallContext(backend, { scope: "project" })
    assert.ok(result.count >= 1)
  } finally {
    await cleanup()
  }
})

// --- update behavior ---

test("rememberContext: updates existing entry on high-scoring duplicate", async () => {
  const { backend, cleanup } = await setup()
  try {
    const first = await rememberContext(backend, {
      text: "User prefers terse engineering answers with minimal explanation.",
    })
    assert.equal(first.action, "created")
    const second = await rememberContext(backend, {
      text: "User prefers terse engineering answers with minimal explanation and code examples.",
    })
    assert.equal(second.action, "updated")
    assert.equal(second.entry.id, first.entry.id)
  } finally {
    await cleanup()
  }
})

// --- author ---

test("rememberContext: preserves author field", async () => {
  const { backend, cleanup } = await setup()
  try {
    const result = await rememberContext(backend, {
      text: "Some important fact.",
      author: "claude-code",
    })
    assert.equal(result.entry.author, "claude-code")
  } finally {
    await cleanup()
  }
})

// --- uniqueId deduplication ---

test("rememberContext: generates unique id when slug collides", async () => {
  const { backend, cleanup } = await setup()
  try {
    const first = await rememberContext(backend, {
      id: "facts/test-entry",
      text: "First entry content.",
    })
    const second = await rememberContext(backend, {
      text: "Completely different but same-looking title.",
      type: "fact",
    })
    // They should have different ids
    assert.notEqual(first.entry.id, second.entry.id)
  } finally {
    await cleanup()
  }
})
