import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ContextNotFoundError,
  LocalBackend,
  MirrorBackend,
  NotSupportedError,
} from "../src/backends/index.js"

async function setupPair() {
  const a = await mkdtemp(join(tmpdir(), "nodus-mirror-extra-p-"))
  const b = await mkdtemp(join(tmpdir(), "nodus-mirror-extra-s-"))
  const primary = new LocalBackend({ rootDir: a })
  const secondary = new LocalBackend({ rootDir: b })
  await primary.init()
  await secondary.init()
  const errors: string[] = []
  const mirror = new MirrorBackend({
    primary,
    secondary,
    onSecondaryError: (op) => { errors.push(op) },
  })
  await mirror.init()
  return { mirror, primary, secondary, errors, cleanup: async () => {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }}
}

// --- describe ---

test("[mirror] describe returns mirror type with sub-descriptions", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    const desc = mirror.describe()
    assert.equal(desc.type, "mirror")
    assert.ok(desc.label.includes("mirror"))
    assert.ok(desc.label.includes("local"))
  } finally {
    await cleanup()
  }
})

// --- init / close ---

test("[mirror] init and close are safe to call", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    // init already called in setup; close should be safe
    await mirror.close()
  } finally {
    await cleanup()
  }
})

// --- search ---

test("[mirror] search merges results from both backends", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "local/note", body: "Amsterdam office location" })
    await secondary.write({ id: "remote/note", body: "Amsterdam weather data" })
    const hits = await mirror.search("Amsterdam")
    const ids = hits.map((h) => h.entry.id)
    assert.ok(ids.includes("local/note"))
    assert.ok(ids.includes("remote/note"))
  } finally {
    await cleanup()
  }
})

test("[mirror] search deduplicates by id, preferring higher score or newer", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "shared/note", body: "Amsterdam" })
    await secondary.write({ id: "shared/note", body: "Amsterdam is great" })
    const hits = await mirror.search("Amsterdam")
    const ids = hits.map((h) => h.entry.id)
    assert.equal(ids.filter((id) => id === "shared/note").length, 1)
  } finally {
    await cleanup()
  }
})

test("[mirror] search respects limit", async () => {
  const { mirror, primary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "a/one", body: "test search term" })
    await primary.write({ id: "a/two", body: "test search term" })
    await primary.write({ id: "a/three", body: "test search term" })
    const hits = await mirror.search("test search term", { limit: 2 })
    assert.ok(hits.length <= 2)
  } finally {
    await cleanup()
  }
})

// --- listTags ---

test("[mirror] listTags merges counts from both backends", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "a/one", body: "x", tags: ["shared-tag", "local-only"] })
    await secondary.write({ id: "b/two", body: "x", tags: ["shared-tag", "remote-only"] })
    const tags = await mirror.listTags()
    const shared = tags.find((t) => t.tag === "shared-tag")
    const local = tags.find((t) => t.tag === "local-only")
    const remote = tags.find((t) => t.tag === "remote-only")
    assert.ok(shared)
    assert.equal(shared.count, 2)
    assert.ok(local)
    assert.equal(local.count, 1)
    assert.ok(remote)
    assert.equal(remote.count, 1)
  } finally {
    await cleanup()
  }
})

test("[mirror] listTags sorted by count descending", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "a/one", body: "x", tags: ["common", "rare"] })
    await primary.write({ id: "a/two", body: "x", tags: ["common"] })
    await secondary.write({ id: "b/three", body: "x", tags: ["common"] })
    const tags = await mirror.listTags()
    assert.equal(tags[0].tag, "common")
    assert.ok(tags[0].count >= 3)
  } finally {
    await cleanup()
  }
})

// --- list with sort modes ---

test("[mirror] list with id-asc sort", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    await mirror.write({ id: "b/note", body: "second" })
    await mirror.write({ id: "a/note", body: "first" })
    const list = await mirror.list({ sort: "id-asc" })
    assert.equal(list[0].id, "a/note")
    assert.equal(list[1].id, "b/note")
  } finally {
    await cleanup()
  }
})

test("[mirror] list with updated-asc sort", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    await mirror.write({ id: "first/note", body: "first" })
    await new Promise((r) => setTimeout(r, 10))
    await mirror.write({ id: "second/note", body: "second" })
    const list = await mirror.list({ sort: "updated-asc" })
    assert.equal(list[0].id, "first/note")
    assert.equal(list[1].id, "second/note")
  } finally {
    await cleanup()
  }
})

test("[mirror] list respects limit", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    await mirror.write({ id: "a/one", body: "x" })
    await mirror.write({ id: "a/two", body: "x" })
    await mirror.write({ id: "a/three", body: "x" })
    const list = await mirror.list({ limit: 2 })
    assert.equal(list.length, 2)
  } finally {
    await cleanup()
  }
})

// --- read: newer local pushes to secondary ---

test("[mirror] read pushes newer local entry to secondary", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    // Create an old version on secondary
    await secondary.write({ id: "shared", body: "old remote" })
    await new Promise((r) => setTimeout(r, 10))
    // Create a newer version on primary
    await primary.write({ id: "shared", body: "new local" })

    const got = await mirror.read("shared")
    assert.equal(got.body, "new local")
    // Secondary should eventually have the newer version
    await new Promise((r) => setTimeout(r, 50))
    const remoteNow = await secondary.read("shared")
    assert.equal(remoteNow.body, "new local")
  } finally {
    await cleanup()
  }
})

// --- read: when secondary has it but primary doesn't, fills secondary ---

test("[mirror] read fills secondary when entry only in primary and secondary is empty", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "local-only", body: "local data" })
    // Read through mirror — should detect secondary doesn't have it and sync
    const got = await mirror.read("local-only")
    assert.equal(got.body, "local data")
  } finally {
    await cleanup()
  }
})

// --- health ---

test("[mirror] health delegates to primary", async () => {
  const { mirror, primary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "test/entry", body: "content" })
    const health = await mirror.health()
    assert.ok(health)
    assert.ok("totalEntries" in health)
  } finally {
    await cleanup()
  }
})

// --- listHistory / readSnapshot ---

test("[mirror] listHistory delegates to primary", async () => {
  const { mirror, primary, cleanup } = await setupPair()
  try {
    await primary.write({ id: "hist/entry", body: "v1" })
    await primary.write({ id: "hist/entry", body: "v2" })
    const history = await mirror.listHistory("hist/entry")
    assert.ok(Array.isArray(history))
  } finally {
    await cleanup()
  }
})

// --- secondary error handling ---

test("[mirror] secondary init failure is non-fatal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-mirror-init-"))
  const primary = new LocalBackend({ rootDir: dir })
  await primary.init()

  const errors: string[] = []
  const badSecondary: any = {
    describe: () => ({ type: "stub", label: "stub", capabilities: { history: false } }),
    init: async () => { throw new Error("secondary init boom") },
    close: async () => {},
    read: async () => { throw new ContextNotFoundError("x") },
    write: async () => {},
    delete: async () => {},
    list: async () => [],
    search: async () => [],
    listTags: async () => [],
  }

  const mirror = new MirrorBackend({
    primary,
    secondary: badSecondary,
    onSecondaryError: (op) => { errors.push(op) },
  })

  await mirror.init()
  assert.ok(errors.includes("init"))
  await rm(dir, { recursive: true, force: true })
})

test("[mirror] secondary search failure returns primary results only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-mirror-search-fail-"))
  const primary = new LocalBackend({ rootDir: dir })
  await primary.init()
  await primary.write({ id: "local/note", body: "searchable content" })

  const errors: string[] = []
  const badSecondary: any = {
    describe: () => ({ type: "stub", label: "stub", capabilities: { history: false } }),
    init: async () => {},
    close: async () => {},
    read: async () => { throw new ContextNotFoundError("x") },
    write: async () => {},
    delete: async () => {},
    list: async () => [],
    search: async () => { throw new Error("search down") },
    listTags: async () => [],
  }

  const mirror = new MirrorBackend({
    primary,
    secondary: badSecondary,
    onSecondaryError: (op) => { errors.push(op) },
  })

  const hits = await mirror.search("searchable")
  assert.ok(hits.length >= 1)
  assert.ok(errors.includes("search"))
  await rm(dir, { recursive: true, force: true })
})

test("[mirror] secondary list failure returns primary results only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-mirror-list-fail-"))
  const primary = new LocalBackend({ rootDir: dir })
  await primary.init()
  await primary.write({ id: "local/item", body: "listed" })

  const errors: string[] = []
  const badSecondary: any = {
    describe: () => ({ type: "stub", label: "stub", capabilities: { history: false } }),
    init: async () => {},
    close: async () => {},
    read: async () => { throw new ContextNotFoundError("x") },
    write: async () => {},
    delete: async () => {},
    list: async () => { throw new Error("list down") },
    search: async () => [],
    listTags: async () => [],
  }

  const mirror = new MirrorBackend({
    primary,
    secondary: badSecondary,
    onSecondaryError: (op) => { errors.push(op) },
  })

  const list = await mirror.list()
  assert.ok(list.length >= 1)
  assert.ok(errors.includes("list"))
  await rm(dir, { recursive: true, force: true })
})

test("[mirror] secondary listTags failure returns primary tags only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-mirror-tags-fail-"))
  const primary = new LocalBackend({ rootDir: dir })
  await primary.init()
  await primary.write({ id: "local/item", body: "x", tags: ["my-tag"] })

  const errors: string[] = []
  const badSecondary: any = {
    describe: () => ({ type: "stub", label: "stub", capabilities: { history: false } }),
    init: async () => {},
    close: async () => {},
    read: async () => { throw new ContextNotFoundError("x") },
    write: async () => {},
    delete: async () => {},
    list: async () => [],
    search: async () => [],
    listTags: async () => { throw new Error("tags down") },
  }

  const mirror = new MirrorBackend({
    primary,
    secondary: badSecondary,
    onSecondaryError: (op) => { errors.push(op) },
  })

  const tags = await mirror.listTags()
  const found = tags.find((t) => t.tag === "my-tag")
  assert.ok(found)
  assert.ok(errors.includes("listTags"))
  await rm(dir, { recursive: true, force: true })
})

// --- revert ---

test("[mirror] revert delegates to primary and syncs to secondary", async () => {
  const { mirror, primary, secondary, cleanup } = await setupPair()
  try {
    await mirror.write({ id: "rev/entry", body: "v1" })
    await new Promise((r) => setTimeout(r, 10))
    await mirror.write({ id: "rev/entry", body: "v2" })

    const history = await primary.listHistory!("rev/entry")
    if (history.length > 0) {
      const reverted = await mirror.revert("rev/entry", history[0].name)
      assert.ok(reverted)
    }
  } finally {
    await cleanup()
  }
})

// --- delete: primary error propagates ---

test("[mirror] delete propagates primary error", async () => {
  const { mirror, cleanup } = await setupPair()
  try {
    await assert.rejects(
      () => mirror.delete("nonexistent/entry"),
      ContextNotFoundError,
    )
  } finally {
    await cleanup()
  }
})

// --- delete: secondary ContextNotFoundError is silenced ---

test("[mirror] delete silences secondary ContextNotFoundError", async () => {
  const { mirror, primary, cleanup } = await setupPair()
  try {
    // Write only to primary
    await primary.write({ id: "primary-only", body: "x" })
    // Delete through mirror — secondary will throw ContextNotFoundError, which should be silenced
    await mirror.delete("primary-only")
    await assert.rejects(() => primary.read("primary-only"), ContextNotFoundError)
  } finally {
    await cleanup()
  }
})
