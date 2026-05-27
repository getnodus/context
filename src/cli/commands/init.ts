import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { detectTargets, installMcp, mcpCommand, localMcpCommand } from "../integrations.js"
import { confirm } from "../prompt.js"
import { bold, cyan, dim, green, info, yellow } from "../output.js"
import { getDefaultLocalDir } from "../../backends/index.js"

export interface InitOptions {
  yes?: boolean
  only?: string[]
  local?: boolean
  dryRun?: boolean
}

export async function runInit(opts: InitOptions): Promise<void> {
  info(bold("nodus-context setup"))
  info(dim("Default local storage: ") + cyan(getDefaultLocalDir()))
  if (opts.dryRun) info(yellow("dry-run: no changes will be written"))
  info("")

  const all = await detectTargets()
  const filter = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined
  const targets = filter ? all.filter((t) => filter.has(t.id)) : all

  if (targets.length === 0) {
    info(yellow("no matching agents to configure"))
    return
  }

  info("Detected agents:")
  for (const t of all) {
    const mark = t.detected ? green("●") : dim("○")
    info(`  ${mark} ${t.name}  ${dim(t.configPath)}`)
  }
  info("")

  const candidates = targets.filter((t) => t.detected || filter?.has(t.id))
  if (candidates.length === 0) {
    info(yellow("no agents detected — install Claude Desktop, Claude Code, or Cursor first"))
    info(dim("or pass --only=<id> to force-write a config"))
    return
  }

  const cmd = opts.local ? localMcpCommand(resolveLocalServerPath()) : mcpCommand()
  info(`MCP command: ${cyan(cmd.command + " " + cmd.args.join(" "))}`)
  info("")

  const names = candidates.map((t) => t.name).join(", ")
  if (!opts.yes && !opts.dryRun) {
    const ok = await confirm(`Add nodus-context MCP server to: ${names}?`, true)
    if (!ok) {
      info("aborted")
      return
    }
  }

  for (const t of candidates) {
    if (opts.dryRun) {
      info(`  ${yellow("would install")}  ${t.name}  ${dim(t.configPath)}`)
      continue
    }
    try {
      const result = await installMcp(t, cmd)
      const tag =
        result.status === "installed"
          ? green("installed")
          : result.status === "updated"
            ? yellow("updated")
            : dim("already installed")
      info(`  ${tag}  ${t.name}`)
    } catch (e) {
      info(`  ${dim("failed   ")} ${t.name}: ${(e as Error).message}`)
    }
  }

  info("")
  info(dim("Restart your agent(s) to pick up the new MCP server."))
}

function resolveLocalServerPath(): string {
  // src/cli/commands/init.ts → dist/cli/commands/init.js at runtime.
  // The MCP server lives at dist/mcp/server.js.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..", "..", "mcp", "server.js")
}
