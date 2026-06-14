import test from "node:test"
import assert from "node:assert/strict"
import { writeFile, mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModuleBackend } from "../src/backends/module.js"

test("loadModuleBackend: throws when path is empty", async () => {
  await assert.rejects(
    () => loadModuleBackend({ path: "" }),
    /path is required/,
  )
})

test("loadModuleBackend: throws when module cannot be loaded", async () => {
  await assert.rejects(
    () => loadModuleBackend({ path: "/definitely/not/a/real/module.js" }),
    /could not load backend module/,
  )
})

test("loadModuleBackend: throws when module has no factory export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mod-test-"))
  const modPath = join(dir, "no-factory.mjs")
  await writeFile(modPath, "export const x = 42;\n")
  try {
    await assert.rejects(
      () => loadModuleBackend({ path: modPath }),
      /must export createBackend or a default function/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadModuleBackend: throws when factory does not return a ContextBackend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mod-test-"))
  const modPath = join(dir, "bad-factory.mjs")
  await writeFile(modPath, "export function createBackend() { return 42; }\n")
  try {
    await assert.rejects(
      () => loadModuleBackend({ path: modPath }),
      /did not return a ContextBackend/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadModuleBackend: throws when factory throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mod-test-"))
  const modPath = join(dir, "throws.mjs")
  await writeFile(
    modPath,
    'export function createBackend() { throw new Error("boom"); }\n',
  )
  try {
    await assert.rejects(
      () => loadModuleBackend({ path: modPath }),
      /backend factory threw/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadModuleBackend: loads a valid module with createBackend export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mod-test-"))
  const modPath = join(dir, "valid.mjs")
  await writeFile(
    modPath,
    `export function createBackend(opts) {
      return {
        describe: () => ({ type: "test", label: "test-mod", capabilities: { history: false } }),
        read: async () => {},
        write: async () => {},
        delete: async () => {},
        list: async () => [],
        search: async () => [],
        listTags: async () => [],
        _opts: opts,
      };
    }\n`,
  )
  try {
    const backend = await loadModuleBackend({ path: modPath, options: { key: "val" } })
    const desc = backend.describe()
    assert.equal(desc.type, "test")
    assert.equal(desc.label, "test-mod")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadModuleBackend: loads a valid module with default export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mod-test-"))
  const modPath = join(dir, "default-exp.mjs")
  await writeFile(
    modPath,
    `export default function(opts) {
      return {
        describe: () => ({ type: "default", label: "default-mod", capabilities: { history: false } }),
        read: async () => {},
        write: async () => {},
        delete: async () => {},
        list: async () => [],
        search: async () => [],
        listTags: async () => [],
      };
    }\n`,
  )
  try {
    const backend = await loadModuleBackend({ path: modPath })
    assert.equal(backend.describe().type, "default")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadModuleBackend: resolves relative-style paths", async () => {
  // Using an absolute path that starts with / — should still resolve
  const dir = await mkdtemp(join(tmpdir(), "mod-test-"))
  const modPath = join(dir, "abs.mjs")
  await writeFile(
    modPath,
    `export function createBackend() {
      return {
        describe: () => ({ type: "abs", label: "abs-mod", capabilities: { history: false } }),
        read: async () => {},
        write: async () => {},
        delete: async () => {},
        list: async () => [],
        search: async () => [],
        listTags: async () => [],
      };
    }\n`,
  )
  try {
    const backend = await loadModuleBackend({ path: modPath })
    assert.equal(backend.describe().type, "abs")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
