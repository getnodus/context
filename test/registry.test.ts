import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  builtInAgents,
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

test("OpenCode entryShape writes {type, command-as-array, enabled} and reads back canonical", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "opencode.json")
    const def: AgentDefinition = {
      id: "opencode-clone",
      name: "OpenCode-clone",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: {
        type: "json-merge",
        path: mcpFile,
        keyPath: ["mcp"],
        entryShape: "opencode",
      },
    }
    const resolved = mkResolved(def)
    const cmd = mcpCommandNpx()
    const installed = await installAgent(resolved, cmd)
    assert.equal(installed.status, "installed")

    // On disk: OpenCode shape — single `command` array, `type: "local"`, `enabled: true`.
    const raw = JSON.parse(await readFile(mcpFile, "utf8"))
    const entry = raw.mcp?.["nodus-context"]
    assert.ok(entry, "entry should land under mcp.nodus-context")
    assert.equal(entry.type, "local")
    assert.equal(entry.enabled, true)
    assert.ok(Array.isArray(entry.command), "command should be a single array")
    assert.equal(entry.command[0], cmd.command)
    assert.deepEqual(entry.command.slice(1), cmd.args)
    assert.equal(entry.args, undefined, "args should NOT be a separate key")

    // Read path inverse-transforms back to canonical {command, args}.
    const read = await readMcp(resolved)
    assert.equal(read?.command, cmd.command)
    assert.deepEqual(read?.args, cmd.args)

    // Re-installing with same command is detected as already-installed
    // (proves the comparison works on the inverse-transformed shape).
    const second = await installAgent(resolved, cmd)
    assert.equal(second.status, "already-installed")

    // Uninstall removes the key cleanly.
    assert.equal(await uninstallAgent(resolved), true)
    const after = JSON.parse(await readFile(mcpFile, "utf8"))
    assert.equal(after.mcp?.["nodus-context"], undefined)
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

test("VS Code entryShape writes `type: stdio` under `servers` and round-trips", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "vscode-mcp.json")
    const def: AgentDefinition = {
      id: "vscode-clone",
      name: "VS Code-clone",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: { type: "json-merge", path: mcpFile, keyPath: ["servers"], entryShape: "vscode" },
    }
    const resolved = mkResolved(def)
    const cmd = mcpCommandNpx()
    await installAgent(resolved, cmd)

    const raw = JSON.parse(await readFile(mcpFile, "utf8"))
    const entry = raw.servers?.["nodus-context"]
    assert.ok(entry, "entry should land under servers")
    assert.equal(entry.type, "stdio", "VS Code entries carry an explicit type: stdio")
    assert.equal(entry.command, cmd.command)
    assert.deepEqual(entry.args, cmd.args)
    assert.equal(raw.mcpServers, undefined)

    // Reads back as the canonical shape (the `type` discriminator is stripped).
    const read = await readMcp(resolved)
    assert.equal(read?.command, cmd.command)
    assert.deepEqual(read?.args, cmd.args)

    // Re-install with same command compares on the canonical shape.
    const second = await installAgent(resolved, cmd)
    assert.equal(second.status, "already-installed")

    assert.equal(await uninstallAgent(resolved), true)
    const after = JSON.parse(await readFile(mcpFile, "utf8"))
    assert.equal(after.servers?.["nodus-context"], undefined)
  })
})

test("Jan entryShape writes `active: true` and round-trips to canonical", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "jan_mcp_config.json")
    const def: AgentDefinition = {
      id: "jan-clone",
      name: "Jan-clone",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: { type: "json-merge", path: mcpFile, entryShape: "jan" },
    }
    const resolved = mkResolved(def)
    const cmd = mcpCommandNpx()
    await installAgent(resolved, cmd)

    const raw = JSON.parse(await readFile(mcpFile, "utf8"))
    const entry = raw.mcpServers?.["nodus-context"]
    assert.ok(entry, "entry should land under mcpServers")
    assert.equal(entry.active, true, "Jan entries are enabled with active: true")
    assert.equal(entry.command, cmd.command)
    assert.deepEqual(entry.args, cmd.args)

    // Reads back canonical (the `active` flag is stripped).
    const read = await readMcp(resolved)
    assert.equal(read?.command, cmd.command)
    assert.deepEqual(read?.args, cmd.args)

    const second = await installAgent(resolved, cmd)
    assert.equal(second.status, "already-installed")

    assert.equal(await uninstallAgent(resolved), true)
  })
})

test("BoltAI is registered as a json-merge agent at ~/.boltai/mcp.json", async () => {
  await withConfigDir(async () => {
    const agents = await loadAgents()
    const rec = agents.find((a) => a.definition.id === "boltai")
    assert.ok(rec, "boltai should be a registered built-in")
    const install = rec!.definition.install
    assert.equal(install.type, "json-merge")
    assert.ok(
      (install as { path: string }).path.endsWith(join(".boltai", "mcp.json")),
      "boltai should install into ~/.boltai/mcp.json",
    )
    assert.equal((install as { entryShape?: string }).entryShape, undefined, "BoltAI uses the canonical entry shape")
  })
})

test("BoltAI install + read + uninstall round-trip (canonical mcpServers)", async () => {
  await withConfigDir(async (configDir) => {
    const mcpFile = join(configDir, "boltai-mcp.json")
    const def: AgentDefinition = {
      id: "boltai-clone",
      name: "BoltAI-clone",
      configPathHint: mcpFile,
      detect: { type: "always" },
      install: { type: "json-merge", path: mcpFile },
    }
    const resolved = mkResolved(def)
    const cmd = mcpCommandNpx()
    assert.equal((await installAgent(resolved, cmd)).status, "installed")

    const raw = JSON.parse(await readFile(mcpFile, "utf8"))
    const entry = raw.mcpServers?.["nodus-context"]
    assert.ok(entry, "entry should land under mcpServers")
    assert.equal(entry.command, cmd.command)
    assert.deepEqual(entry.args, cmd.args)

    const read = await readMcp(resolved)
    assert.equal(read?.command, cmd.command)
    assert.equal((await installAgent(resolved, cmd)).status, "already-installed")
    assert.equal(await uninstallAgent(resolved), true)
  })
})

test("LM Studio, Warp, and Jan are registered with the expected install targets", async () => {
  await withConfigDir(async () => {
    const agents = await loadAgents()
    for (const id of ["lm-studio", "warp", "jan"]) {
      const rec = agents.find((a) => a.definition.id === id)
      assert.ok(rec, `${id} should be a registered built-in`)
      assert.equal(rec!.definition.install.type, "json-merge")
    }
  })
})

test(
  "LM Studio install path falls back to ~/.cache/lm-studio on macOS when ~/.lmstudio is absent (bug #1371)",
  { skip: process.platform !== "darwin" },
  async () => {
    await withConfigDir(async (configDir) => {
      const prevHome = process.env.HOME
      process.env.HOME = configDir
      try {
        const lmPath = () => {
          const def = builtInAgents().find((a) => a.id === "lm-studio")
          assert.ok(def, "lm-studio should be registered")
          return (def!.install as { path: string }).path
        }
        // Cache dir exists, documented dir does not → target the cache path.
        await mkdir(join(configDir, ".cache", "lm-studio"), { recursive: true })
        assert.ok(
          lmPath().endsWith(join(".cache", "lm-studio", "mcp.json")),
          "should target the cache path when only it exists",
        )
        // Once ~/.lmstudio exists, prefer the documented path.
        await mkdir(join(configDir, ".lmstudio"), { recursive: true })
        assert.ok(
          lmPath().endsWith(join(".lmstudio", "mcp.json")),
          "should prefer the documented path once it exists",
        )
      } finally {
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }
    })
  },
)

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
