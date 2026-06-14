import test from "node:test"
import assert from "node:assert/strict"
import {
  compareSemver,
  upgradeCommand,
  manualUpgradeCommand,
  upgradeHint,
} from "../src/cli/update-check.js"

// --- compareSemver ---

test("compareSemver: equal versions return 0", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0)
})

test("compareSemver: higher major returns positive", () => {
  assert.ok(compareSemver("2.0.0", "1.0.0") > 0)
})

test("compareSemver: lower major returns negative", () => {
  assert.ok(compareSemver("1.0.0", "2.0.0") < 0)
})

test("compareSemver: higher minor returns positive", () => {
  assert.ok(compareSemver("1.2.0", "1.1.0") > 0)
})

test("compareSemver: higher patch returns positive", () => {
  assert.ok(compareSemver("1.0.2", "1.0.1") > 0)
})

test("compareSemver: strips leading v", () => {
  assert.equal(compareSemver("v1.2.3", "1.2.3"), 0)
})

test("compareSemver: pre-release sorts below release", () => {
  assert.ok(compareSemver("1.2.3-beta.1", "1.2.3") < 0)
})

test("compareSemver: release sorts above pre-release", () => {
  assert.ok(compareSemver("1.2.3", "1.2.3-beta.1") > 0)
})

test("compareSemver: pre-releases sort lexicographically", () => {
  assert.ok(compareSemver("1.2.3-alpha", "1.2.3-beta") < 0)
  assert.ok(compareSemver("1.2.3-beta", "1.2.3-alpha") > 0)
})

test("compareSemver: equal pre-releases return 0", () => {
  assert.equal(compareSemver("1.2.3-beta.1", "1.2.3-beta.1"), 0)
})

test("compareSemver: handles short versions by padding", () => {
  assert.equal(compareSemver("1.2", "1.2.0"), 0)
  assert.equal(compareSemver("1", "1.0.0"), 0)
})

test("compareSemver: handles non-numeric parts gracefully", () => {
  // Non-numeric parts default to 0 in the core
  assert.equal(compareSemver("0.0.0", "abc.def.ghi"), 0)
})

// --- upgradeCommand ---

test("upgradeCommand: returns context update", () => {
  assert.equal(upgradeCommand(), "context update")
})

// --- manualUpgradeCommand ---

test("manualUpgradeCommand: returns npm install command", () => {
  assert.ok(manualUpgradeCommand().includes("npm install -g"))
  assert.ok(manualUpgradeCommand().includes("@getnodus/context"))
})

// --- upgradeHint ---

test("upgradeHint: includes version info and command", () => {
  const hint = upgradeHint({ current: "0.1.0", latest: "0.2.0", outdated: true, checkedAt: "2025-01-01T00:00:00Z" })
  assert.ok(hint.includes("0.1.0"))
  assert.ok(hint.includes("0.2.0"))
  assert.ok(hint.includes("context update"))
})
