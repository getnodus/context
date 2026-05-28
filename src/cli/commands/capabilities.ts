import { packageVersion } from "../version.js"
import { loadAgents } from "../agents/index.js"
import { bold, cyan, dim, green, info } from "../output.js"

export interface CapabilitiesArgs {
  json?: boolean
}

/**
 * Machine-readable feature inventory. Designed for AI assistants doing
 * "do you support X?" checks before calling other commands. Stable shape
 * across versions; new fields may be added but existing ones don't change
 * meaning.
 */
export async function cmdCapabilities(args: CapabilitiesArgs): Promise<void> {
  const agents = await loadAgents()
  const capabilities = {
    name: "@getnodus/context",
    version: packageVersion(),
    protocol: { http: 1, mcp: "stdio" },
    backends: ["local", "http", "mirror", "module"],
    commands: [
      "setup",
      "init",
      "uninstall",
      "doctor",
      "join",
      "capabilities",
      "use",
      "profile",
      "config",
      "list",
      "show",
      "add",
      "edit",
      "search",
      "delete",
      "tags",
      "stale",
      "history",
      "revert",
      "snapshot",
      "export",
      "import",
      "sync",
      "agents",
      "path",
      "mcp",
    ],
    agents: agents.map((a) => ({
      id: a.definition.id,
      name: a.definition.name,
      source: a.source,
      install: a.definition.install.type,
    })),
    features: {
      pairing: true,
      mdnsDiscovery: true,
      wizard: true,
      setup: true,
      mirrorBackend: true,
      semanticSearch: true,
      history: true,
      customAgents: true,
    },
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(capabilities, null, 2) + "\n")
    return
  }

  info(bold(`@getnodus/context v${capabilities.version}`))
  info(`${dim("protocol:")} http v${capabilities.protocol.http} · mcp ${capabilities.protocol.mcp}`)
  info(`${dim("backends:")} ${capabilities.backends.join(", ")}`)
  info(`${dim("agents  :")} ${agents.length} known`)
  for (const a of capabilities.agents) {
    info(`  ${green("•")} ${cyan(a.id.padEnd(16))} ${dim(a.install.padEnd(12))} ${a.name}  ${dim(`(${a.source})`)}`)
  }
  info(`${dim("features:")} ${Object.entries(capabilities.features)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ")}`)
}
