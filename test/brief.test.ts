import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalBackend } from "../src/backends/index.js"
import { renderBrief } from "../src/mcp/brief.js"

async function newBackend() {
  const dir = await mkdtemp(join(tmpdir(), "ctx-brief-"))
  const backend = new LocalBackend({ rootDir: dir })
  await backend.init()
  return { backend, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function seed(backend: LocalBackend) {
  await backend.write({ id: "user/identity", type: "fact", body: "Fischer, in Amsterdam." })
  await backend.write({ id: "rules/no-merge", type: "rule", body: "Never merge without asking." })
  await backend.write({
    id: "projects/myrepo",
    type: "project-state",
    body: "Shipping the brief refactor.",
  })
  await backend.write({
    id: "decisions/2026-05-01-other",
    type: "decision",
    tags: ["otherrepo"],
    body: "Chose X for the other project.",
  })
}

test("renderBrief: no hints → no workspace section, brief unchanged", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await seed(backend)
    const brief = await renderBrief(backend, backend.describe())
    assert.ok(!brief.includes("## This workspace"), "workspace section omitted without hints")
    assert.ok(brief.includes("## Rules"), "always-on sections still present")
  } finally {
    await cleanup()
  }
})

test("renderBrief: hint surfaces matching project entry, ignores non-matches", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    await seed(backend)
    const brief = await renderBrief(backend, backend.describe(), { hints: ["myrepo"] })
    assert.ok(brief.includes("## This workspace"), "workspace section present")
    assert.ok(brief.includes("projects/myrepo"), "matching entry surfaced")
    assert.ok(
      !brief.includes("decisions/2026-05-01-other"),
      "non-matching project entry not surfaced",
    )
    assert.ok(brief.includes("`myrepo`"), "subtitle names the hint")
  } finally {
    await cleanup()
  }
})

test("renderBrief: workspace section never repeats an always-on entry", async () => {
  const { backend, cleanup } = await newBackend()
  try {
    // A rule whose id matches the hint — it must show under Rules, not twice.
    await backend.write({ id: "rules/myrepo-policy", type: "rule", body: "Repo policy." })
    const brief = await renderBrief(backend, backend.describe(), { hints: ["myrepo"] })
    const occurrences = brief.split("rules/myrepo-policy").length - 1
    assert.equal(occurrences, 1, "rule shown once, not duplicated in workspace section")
  } finally {
    await cleanup()
  }
})
