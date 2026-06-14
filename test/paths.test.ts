import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import {
  validateId,
  idToPath,
  pathToId,
  getDefaultLocalDir,
  getNodusConfigDir,
} from "../src/backends/paths.js"

// --- validateId ---

test("validateId: accepts simple ids", () => {
  assert.doesNotThrow(() => validateId("user/identity"))
  assert.doesNotThrow(() => validateId("projects/nodus"))
  assert.doesNotThrow(() => validateId("a"))
  assert.doesNotThrow(() => validateId("a.b"))
  assert.doesNotThrow(() => validateId("a-b"))
  assert.doesNotThrow(() => validateId("a_b"))
})

test("validateId: rejects empty id", () => {
  assert.throws(() => validateId(""), /non-empty/)
})

test("validateId: rejects too-long id", () => {
  assert.throws(() => validateId("a".repeat(201)), /too long/)
})

test("validateId: rejects leading slash", () => {
  assert.throws(() => validateId("/user"), /start or end/)
})

test("validateId: rejects trailing slash", () => {
  assert.throws(() => validateId("user/"), /start or end/)
})

test("validateId: rejects double slash", () => {
  assert.throws(() => validateId("user//identity"), /\/\//)
})

test("validateId: rejects path traversal", () => {
  assert.throws(() => validateId("user/../etc"), /\.\./)
})

test("validateId: rejects invalid segment characters", () => {
  assert.throws(() => validateId("user/ space"), /alphanumeric/)
})

// --- idToPath ---

test("idToPath: converts id to expected file path", () => {
  const result = idToPath("/root", "user/identity")
  assert.equal(result, join("/root", "user", "identity.md"))
})

test("idToPath: validates the id", () => {
  assert.throws(() => idToPath("/root", ""), /non-empty/)
})

// --- pathToId ---

test("pathToId: converts file path back to id", () => {
  const result = pathToId("/root", join("/root", "user", "identity.md"))
  assert.equal(result, "user/identity")
})

test("pathToId: rejects non-markdown file", () => {
  assert.throws(
    () => pathToId("/root", join("/root", "user", "identity.txt")),
    /not a markdown file/,
  )
})

test("pathToId: rejects file outside root", () => {
  assert.throws(
    () => pathToId("/root", "/other/file.md"),
    /outside context root/,
  )
})

// --- getDefaultLocalDir ---

test("getDefaultLocalDir: respects NODUS_CONTEXT_DIR env", () => {
  const orig = process.env.NODUS_CONTEXT_DIR
  process.env.NODUS_CONTEXT_DIR = "/custom/dir"
  try {
    assert.equal(getDefaultLocalDir(), "/custom/dir")
  } finally {
    if (orig !== undefined) process.env.NODUS_CONTEXT_DIR = orig
    else delete process.env.NODUS_CONTEXT_DIR
  }
})

test("getDefaultLocalDir: defaults to ~/.nodus/context", () => {
  const orig = process.env.NODUS_CONTEXT_DIR
  delete process.env.NODUS_CONTEXT_DIR
  try {
    const result = getDefaultLocalDir()
    assert.ok(result.includes(".nodus"))
    assert.ok(result.includes("context"))
  } finally {
    if (orig !== undefined) process.env.NODUS_CONTEXT_DIR = orig
  }
})

// --- getNodusConfigDir ---

test("getNodusConfigDir: respects NODUS_CONFIG_DIR env", () => {
  const orig = process.env.NODUS_CONFIG_DIR
  process.env.NODUS_CONFIG_DIR = "/custom/config"
  try {
    assert.equal(getNodusConfigDir(), "/custom/config")
  } finally {
    if (orig !== undefined) process.env.NODUS_CONFIG_DIR = orig
    else delete process.env.NODUS_CONFIG_DIR
  }
})

test("getNodusConfigDir: defaults to ~/.nodus", () => {
  const orig = process.env.NODUS_CONFIG_DIR
  delete process.env.NODUS_CONFIG_DIR
  try {
    const result = getNodusConfigDir()
    assert.ok(result.includes(".nodus"))
  } finally {
    if (orig !== undefined) process.env.NODUS_CONFIG_DIR = orig
  }
})
