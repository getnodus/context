import test from "node:test"
import assert from "node:assert/strict"
import {
  ContextBackend,
  ContextNotFoundError,
} from "../src/backends/index.js"

/**
 * Backend conformance suite. Any ContextBackend should pass these tests.
 * Pass a setup function that returns a fresh backend + cleanup.
 */
export function runConformance(
  label: string,
  setup: () => Promise<{ backend: ContextBackend; cleanup: () => Promise<void> }>,
) {
  test(`[${label}] write + read round-trips`, async () => {
    const { backend, cleanup } = await setup()
    try {
      const written = await backend.write({
        id: "user/identity",
        body: "Fischer runs Nodus.",
        tags: ["identity"],
      })
      assert.equal(written.id, "user/identity")
      assert.equal(written.body, "Fischer runs Nodus.")

      const read = await backend.read("user/identity")
      assert.equal(read.body, "Fischer runs Nodus.")
      assert.deepEqual(read.tags, ["identity"])
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] read missing throws ContextNotFoundError`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await assert.rejects(() => backend.read("nope/missing"), ContextNotFoundError)
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] list filters by prefix and tags`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "user/identity", body: "x", tags: ["identity"] })
      await backend.write({ id: "user/role", body: "x", tags: ["identity", "role"] })
      await backend.write({ id: "projects/nodus", body: "x", tags: ["projects"] })

      const users = await backend.list({ prefix: "user" })
      assert.equal(users.length, 2)

      const withRole = await backend.list({ tags: ["role"] })
      assert.equal(withRole.length, 1)
      assert.equal(withRole[0].id, "user/role")
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] search finds across body and id`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "projects/amsterdam", body: "office" })
      await backend.write({ id: "user/identity", body: "based in Amsterdam" })

      const hits = await backend.search("amsterdam")
      assert.equal(hits.length, 2)
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] listTags counts tags`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "a", body: "x", tags: ["foo", "bar"] })
      await backend.write({ id: "b", body: "x", tags: ["foo"] })

      const tags = await backend.listTags()
      const foo = tags.find((t) => t.tag === "foo")
      const bar = tags.find((t) => t.tag === "bar")
      assert.equal(foo?.count, 2)
      assert.equal(bar?.count, 1)
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] delete removes`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "tmp/note", body: "soon to vanish" })
      await backend.delete("tmp/note")
      await assert.rejects(() => backend.read("tmp/note"), ContextNotFoundError)
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] type field round-trips and filters`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "rules/no-force", body: "x", type: "rule" })
      await backend.write({ id: "prefs/tone", body: "x", type: "preference" })
      await backend.write({ id: "facts/location", body: "x", type: "fact" })

      const read = await backend.read("rules/no-force")
      assert.equal(read.type, "rule")

      const rules = await backend.list({ type: "rule" })
      assert.equal(rules.length, 1)

      const ruleOrPref = await backend.list({ type: ["rule", "preference"] })
      assert.equal(ruleOrPref.length, 2)
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] expired entries are filtered by default`, async () => {
    const { backend, cleanup } = await setup()
    try {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      await backend.write({ id: "stale/one", body: "x", expires: past })
      await backend.write({ id: "fresh/one", body: "x", expires: future })

      const visible = await backend.list()
      const ids = visible.map((e) => e.id)
      assert.ok(ids.includes("fresh/one"))
      assert.ok(!ids.includes("stale/one"))

      const withExpired = await backend.list({ includeExpired: true })
      assert.equal(withExpired.length, 2)
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] supersedes round-trips`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "old/decision", body: "old" })
      const newEntry = await backend.write({
        id: "new/decision",
        body: "new",
        supersedes: ["old/decision"],
      })
      assert.deepEqual(newEntry.supersedes, ["old/decision"])

      const read = await backend.read("new/decision")
      assert.deepEqual(read.supersedes, ["old/decision"])
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] author + createdBy round-trip and preserve across rewrites`, async () => {
    const { backend, cleanup } = await setup()
    try {
      const v1 = await backend.write({
        id: "user/identity",
        body: "first version",
        author: "claude-code/1.0.0",
      })
      assert.equal(v1.author, "claude-code/1.0.0")
      assert.equal(v1.createdBy, "claude-code/1.0.0")

      const v2 = await backend.write({
        id: "user/identity",
        body: "second version",
        author: "cursor",
      })
      assert.equal(v2.author, "cursor", "author updated to latest writer")
      assert.equal(v2.createdBy, "claude-code/1.0.0", "createdBy preserved")
    } finally {
      await cleanup()
    }
  })

  test(`[${label}] filter list by author (matches name prefix before slash)`, async () => {
    const { backend, cleanup } = await setup()
    try {
      await backend.write({ id: "a", body: "x", author: "claude-code/1.0" })
      await backend.write({ id: "b", body: "x", author: "claude-code/2.0" })
      await backend.write({ id: "c", body: "x", author: "cursor" })
      await backend.write({ id: "d", body: "x" })

      const claudeOnly = await backend.list({ author: "claude-code" })
      const claudeIds = claudeOnly.map((e) => e.id).sort()
      assert.deepEqual(claudeIds, ["a", "b"])

      const both = await backend.list({ author: ["claude-code", "cursor"] })
      assert.equal(both.length, 3)
    } finally {
      await cleanup()
    }
  })
}
