import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installAgent,
  loadAgents,
  mcpCommandNpx,
  readMcp,
  resolveAgents,
  uninstallAgent,
  type AgentDefinition,
  type ResolvedAgent,
} from "../src/cli/agents/index.js"

async function withConfigDir<T>(
  fn: (configDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nodus-reg-"))
  const prev = process.env.NODUS_CONFIG_DIR
  process.env.NODUS_CONFIG_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.NODUS_CONFIG_DIR
    else process.env.NODUS_CONFIG_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
}

function mkResolved(def: AgentDefinition): ResolvedAgent {
  return {
    id: def.id,
    name: def.name,
    configPath: def.configPathHint,
    detected: true,
    source: "custom",
    definition: def,
  }
}

test("loadAgents returns built-ins by default", async () => {
  await withConfigDir(async () => {
    const agents = await loadAgents()
    const ids = agents.map((a) => a.definition.id)
    for (const expected of ["claude-desktop", "claude-code", "cursor", "cline", "windsurf", "zed"]) {
      assert.ok(ids.includes(expected), `expected built-in "${expected}" to be present, got: ${ids.join(",")}`)
    }
    for (const a of agents) {
      assert.equal(a.source, "built-in")
    }
  })
})

test("loadAgents merges custom agents from config", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "my-agent-mcp.json")
    const config = {
      activeProfile: "default",
      profiles: { default: { type: "local" } },
      customAgents: [
        {
          id: "my-agent",
          name: "My Agent",
          configPathHint: mcpFile,
          detect: { type: "always" },
          install: { type: "json-merge", path: mcpFile },
        } satisfies AgentDefinition,
      ],
    }
    await writeFile(join(configDir, "config.json"), JSON.stringify(config), "utf8")
    const agents = await loadAgents()
    const mine = agents.find((a) => a.definition.id === "my-agent")
    assert.ok(mine, "custom agent should be loaded")
    assert.equal(mine!.source, "custom")
  })
})

test("custom agent shadows built-in with same id", async () => {
  await withConfigDir(async (configDir) => {
    const overridePath = join(configDir, "claude-override.json")
    const config = {
      activeProfile: "default",
      profiles: { default: { type: "local" } },
      customAgents: [
        {
          id: "claude-desktop",
          name: "Claude Desktop (custom path)",
          configPathHint: overridePath,
          detect: { type: "always" },
          install: { type: "json-merge", path: overridePath },
        } satisfies AgentDefinition,
      ],
    }
    await writeFile(join(configDir, "config.json"), JSON.stringify(config), "utf8")
    const agents = await loadAgents()
    const claude = agents.find((a) => a.definition.id === "claude-desktop")
    assert.equal(claude?.source, "custom")
    assert.equal(claude?.definition.name, "Claude Desktop (custom path)")
  })
})

test("install + read + uninstall round-trip via custom agent", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "agent.json")
    const def: AgentDefinition = {
      id: "round-trip",
      name: "Round Trip",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: { type: "json-merge", path: mcpFile },
    }
    const resolved = mkResolved(def)
    const installed = await installAgent(resolved, mcpCommandNpx())
    assert.equal(installed.status, "installed")
    const read = await readMcp(resolved)
    assert.equal(read?.command, "npx")
    const removed = await uninstallAgent(resolved)
    assert.equal(removed, true)
    const after = await readMcp(resolved)
    assert.equal(after, undefined)
  })
})

test("Zed-style keyPath ('context_servers') is honoured", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "zed-settings.json")
    const def: AgentDefinition = {
      id: "zed-clone",
      name: "Zed-clone",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: { type: "json-merge", path: mcpFile, keyPath: ["context_servers"] },
    }
    const resolved = mkResolved(def)
    await installAgent(resolved, mcpCommandNpx())
    const raw = JSON.parse(await readFile(mcpFile, "utf8"))
    assert.ok(raw.context_servers?.["nodus-context"], "entry should land under context_servers")
    assert.equal(raw.mcpServers, undefined)
  })
})

test("readMcp tolerates JSONC (comments + trailing commas)", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "jsonc-settings.json")
    // Hand-written JSONC: line comment, block comment, trailing comma.
    const jsonc = `{
  // user settings
  "context_servers": {
    "nodus-context": {
      "command": "npx",
      "args": ["-y", "--package", "@getnodus/context", "nodus-context-mcp"],
    },
  },
  /* block
     comment */
  "theme": "dark",
}
`
    await writeFile(mcpFile, jsonc, "utf8")
    const def: AgentDefinition = {
      id: "jsonc-agent",
      name: "JSONC Agent",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: { type: "json-merge", path: mcpFile, keyPath: ["context_servers"] },
    }
    const resolved = mkResolved(def)
    const read = await readMcp(resolved)
    assert.equal(read?.command, "npx", "should read entry from JSONC-formatted file")
  })
})

test("detect path-exists works against a real tmp file", async () => {
  await withConfigDir(async (configDir) => {
    const marker = join(configDir, "marker")
    await writeFile(marker, "x", "utf8")
    const def: AgentDefinition = {
      id: "path-exists-agent",
      name: "Path-exists Agent",
      configPathHint: join(configDir, "agent.json"),
      detect: { type: "path-exists", path: marker },
      install: { type: "json-merge", path: join(configDir, "agent.json") },
    }
    const config = {
      activeProfile: "default",
      profiles: { default: { type: "local" } },
      customAgents: [def],
    }
    await writeFile(join(configDir, "config.json"), JSON.stringify(config), "utf8")
    const resolved = await resolveAgents()
    const mine = resolved.find((a) => a.id === "path-exists-agent")
    assert.equal(mine?.detected, true)
  })
})
