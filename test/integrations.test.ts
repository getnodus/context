import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installMcp,
  uninstallMcp,
  readMcp,
  mcpCommand,
  localMcpCommand,
  AgentTarget,
} from "../src/cli/integrations.js"
import type { AgentDefinition } from "../src/cli/agents/index.js"

async function targetFile(keyPath?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-int-"))
  const configPath = join(dir, "config.json")
  const definition: AgentDefinition = {
    id: "test",
    name: "Test Agent",
    configPathHint: configPath,
    detect: { type: "always" },
    install: { type: "json-merge", path: configPath, ...(keyPath ? { keyPath } : {}) },
  }
  return {
    target: {
      id: "test",
      name: "Test Agent",
      configPath,
      detected: true,
      source: "custom" as const,
      definition,
    } as AgentTarget,
    configPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test("installMcp creates config and writes server entry", async () => {
  const { target, configPath, cleanup } = await targetFile()
  try {
    const result = await installMcp(target, mcpCommand())
    assert.equal(result.status, "installed")

    const parsed = JSON.parse(await readFile(configPath, "utf8"))
    assert.ok(parsed.mcpServers["nodus-context"])
    assert.equal(parsed.mcpServers["nodus-context"].command, "npx")
  } finally {
    await cleanup()
  }
})

test("installMcp is idempotent", async () => {
  const { target, cleanup } = await targetFile()
  try {
    await installMcp(target, mcpCommand())
    const second = await installMcp(target, mcpCommand())
    assert.equal(second.status, "already-installed")
  } finally {
    await cleanup()
  }
})

test("installMcp reports update when command changes", async () => {
  const { target, cleanup } = await targetFile()
  try {
    await installMcp(target, mcpCommand())
    const updated = await installMcp(target, localMcpCommand("/tmp/server.js"))
    assert.equal(updated.status, "updated")
    const read = await readMcp(target)
    assert.equal(read?.command, "node")
  } finally {
    await cleanup()
  }
})

test("installMcp preserves other mcpServers entries", async () => {
  const { target, configPath, cleanup } = await targetFile()
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { "some-other": { command: "node", args: ["x"] } },
        otherKey: "preserved",
      }),
      "utf8",
    )
    await installMcp(target, mcpCommand())
    const parsed = JSON.parse(await readFile(configPath, "utf8"))
    assert.ok(parsed.mcpServers["some-other"])
    assert.ok(parsed.mcpServers["nodus-context"])
    assert.equal(parsed.otherKey, "preserved")
  } finally {
    await cleanup()
  }
})

test("uninstallMcp removes only our entry", async () => {
  const { target, cleanup } = await targetFile()
  try {
    await installMcp(target, mcpCommand())
    const removed = await uninstallMcp(target)
    assert.equal(removed, true)
    const second = await uninstallMcp(target)
    assert.equal(second, false)
  } finally {
    await cleanup()
  }
})

// New: json-merge with a custom keyPath (e.g. Zed's `context_servers`).
test("installMcp respects keyPath override", async () => {
  const { target, configPath, cleanup } = await targetFile(["context_servers"])
  try {
    await installMcp(target, mcpCommand())
    const parsed = JSON.parse(await readFile(configPath, "utf8"))
    assert.ok(parsed.context_servers["nodus-context"], "entry should land under context_servers")
    assert.equal(parsed.mcpServers, undefined, "mcpServers key should not be created")
  } finally {
    await cleanup()
  }
})

// New: nested keyPath ([] segments traversed/created in order).
test("installMcp creates nested keyPath chain", async () => {
  const { target, configPath, cleanup } = await targetFile(["nested", "deep", "servers"])
  try {
    await installMcp(target, mcpCommand())
    const parsed = JSON.parse(await readFile(configPath, "utf8"))
    assert.ok(parsed.nested.deep.servers["nodus-context"])
  } finally {
    await cleanup()
  }
})
