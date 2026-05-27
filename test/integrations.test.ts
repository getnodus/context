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

async function targetFile() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-int-"))
  return {
    target: {
      id: "test",
      name: "Test Agent",
      configPath: join(dir, "config.json"),
      detected: true,
    } as AgentTarget,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test("installMcp creates config and writes server entry", async () => {
  const { target, cleanup } = await targetFile()
  try {
    const result = await installMcp(target, mcpCommand())
    assert.equal(result.status, "installed")

    const parsed = JSON.parse(await readFile(target.configPath, "utf8"))
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
  const { target, cleanup } = await targetFile()
  try {
    await writeFile(
      target.configPath,
      JSON.stringify({
        mcpServers: { "some-other": { command: "node", args: ["x"] } },
        otherKey: "preserved",
      }),
      "utf8",
    )
    await installMcp(target, mcpCommand())
    const parsed = JSON.parse(await readFile(target.configPath, "utf8"))
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
