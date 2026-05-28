import test from "node:test"
import assert from "node:assert/strict"
import { lexicalSearch, tokenize } from "../src/backends/lexical.js"
import { ContextEntry } from "../src/backends/types.js"

function entry(id: string, body: string, title?: string, tags: string[] = []): ContextEntry {
  return {
    id,
    title: title ?? id,
    type: "fact",
    tags,
    body,
    created: "2025-01-01T00:00:00.000Z",
    updated: "2025-01-01T00:00:00.000Z",
  }
}

test("tokenize splits camelCase, path segments, hyphens", () => {
  assert.deepEqual(tokenize("user/lastUsedAt"), ["user", "last", "used", "at"])
  assert.deepEqual(tokenize("nodus-context"), ["nodus", "context"])
  assert.deepEqual(tokenize("HTTPServer"), ["http", "server"])
})

test("matches body terms and ranks by relevance", () => {
  const entries = [
    entry("user/identity", "Fischer lives in Amsterdam"),
    entry("projects/coffee", "Strong dark roast every morning"),
    entry("misc/unrelated", "Something else entirely"),
  ]
  const hits = lexicalSearch("amsterdam", entries)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entry.id, "user/identity")
})

test("id and title get boosted over body", () => {
  const entries = [
    entry("misc/note", "this entry happens to mention amsterdam once"),
    entry("projects/amsterdam", "office", "Amsterdam Office"),
  ]
  const hits = lexicalSearch("amsterdam", entries)
  assert.equal(hits[0].entry.id, "projects/amsterdam")
})

test("prefix match catches partial words", () => {
  const entries = [
    entry("user/identity", "Fischer lives in Amsterdam Netherlands"),
    entry("misc/unrelated", "nothing here"),
  ]
  const hits = lexicalSearch("amsterd", entries)
  assert.ok(hits.length >= 1, "prefix matched")
  assert.equal(hits[0].entry.id, "user/identity")
})

test("multi-token query prefers entries hitting more terms", () => {
  const entries = [
    entry("a", "amsterdam mentioned but not coffee"),
    entry("b", "amsterdam coffee morning routine"),
    entry("c", "coffee only, no city mentioned"),
  ]
  const hits = lexicalSearch("amsterdam coffee", entries)
  assert.equal(hits[0].entry.id, "b", "entry matching both terms ranks first")
})

test("rare terms outweigh common ones", () => {
  const entries = [
    entry("a", "the the the the the the the amsterdam"),
    entry("b", "the"),
    entry("c", "the the the the"),
  ]
  const hits = lexicalSearch("amsterdam", entries)
  assert.equal(hits[0].entry.id, "a", "rare-term hit wins regardless of common-term density")
})

test("empty query returns nothing", () => {
  const hits = lexicalSearch("", [entry("a", "x")])
  assert.deepEqual(hits, [])
})

test("tag matches contribute to score", () => {
  const entries = [
    entry("a", "ordinary body", "Note", ["amsterdam"]),
    entry("b", "ordinary body"),
  ]
  const hits = lexicalSearch("amsterdam", entries)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entry.id, "a")
})

test("produces snippets around body matches", () => {
  const long = "lorem ipsum ".repeat(20) + "amsterdam coffee" + " sit amet".repeat(20)
  const hits = lexicalSearch("amsterdam", [entry("a", long)])
  assert.equal(hits.length, 1)
  assert.ok(hits[0].snippets.length > 0)
  assert.ok(hits[0].snippets[0].toLowerCase().includes("amsterdam"))
})
