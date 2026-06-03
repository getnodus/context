import test from "node:test"
import assert from "node:assert/strict"
import {
  deriveWorkspaceHints,
  rootUriToPath,
  selectWorkspaceEntries,
} from "../src/mcp/workspace.js"
import { ContextEntrySummary } from "../src/backends/index.js"

function summary(over: Partial<ContextEntrySummary> & { id: string }): ContextEntrySummary {
  return {
    title: over.id,
    type: "fact",
    tags: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    preview: "",
    ...over,
  }
}

test("deriveWorkspaceHints: leaf + parent, generic containers dropped", () => {
  // A Conductor workspace: …/<repo>/<branch> — both worth matching.
  assert.deepEqual(
    deriveWorkspaceHints(["/Users/fschr/conductor/workspaces/context/edinburgh"]),
    ["context", "edinburgh"],
  )
  // A plain repo under a generic parent: only the repo name survives.
  assert.deepEqual(deriveWorkspaceHints(["/Users/fschr/code/myrepo"]), ["myrepo"])
})

test("deriveWorkspaceHints: lowercases, dedupes, skips dotdirs and empty", () => {
  assert.deepEqual(deriveWorkspaceHints(["/Users/fschr/code/MyRepo"]), ["myrepo"])
  assert.deepEqual(
    deriveWorkspaceHints(["/x/code/foo", "/y/code/foo"]),
    ["foo"],
    "same leaf from two roots collapses to one hint",
  )
  assert.deepEqual(deriveWorkspaceHints(["/Users/fschr/.config"]), ["fschr"])
  assert.deepEqual(deriveWorkspaceHints([]), [])
})

test("rootUriToPath: file URIs only", () => {
  assert.equal(rootUriToPath("file:///Users/fschr/code/myrepo"), "/Users/fschr/code/myrepo")
  assert.equal(rootUriToPath("https://example.com"), null)
  assert.equal(rootUriToPath("not a uri"), null)
})

test("selectWorkspaceEntries: matches id segments and tags, newest first", () => {
  const all = [
    summary({ id: "projects/myrepo", updated: "2026-02-01T00:00:00.000Z" }),
    summary({ id: "decisions/2026-05-01-myrepo-auth", updated: "2026-05-01T00:00:00.000Z" }),
    summary({ id: "facts/unrelated", tags: ["myrepo"], updated: "2026-03-01T00:00:00.000Z" }),
    summary({ id: "facts/nope", tags: ["other"] }),
  ]
  const got = selectWorkspaceEntries(all, ["myrepo"]).map((e) => e.id)
  assert.deepEqual(got, [
    "decisions/2026-05-01-myrepo-auth", // newest
    "facts/unrelated", // tag match
    "projects/myrepo",
  ])
})

test("selectWorkspaceEntries: substrings don't match, only whole segments", () => {
  const all = [summary({ id: "projects/mycontextual-thing" })]
  // hint "context" must not match the segment "mycontextual"
  assert.deepEqual(selectWorkspaceEntries(all, ["context"]), [])
})

test("selectWorkspaceEntries: excludeIds and empty hints", () => {
  const all = [summary({ id: "projects/myrepo" })]
  assert.deepEqual(selectWorkspaceEntries(all, ["myrepo"], new Set(["projects/myrepo"])), [])
  assert.deepEqual(selectWorkspaceEntries(all, []), [])
})
