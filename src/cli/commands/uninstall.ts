import { detectTargets, readMcp, uninstallMcp } from "../integrations.js"
import { confirm } from "../prompt.js"
import { bold, cyan, dim, green, info, red, yellow } from "../output.js"

export interface UninstallOptions {
  yes?: boolean
  only?: string[]
  dryRun?: boolean
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  info(bold("context uninstall"))
  if (opts.dryRun) info(yellow("dry-run: no changes will be written"))
  info("")

  const all = await detectTargets()
  const filter = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined
  const targets = filter ? all.filter((t) => filter.has(t.id)) : all

  if (targets.length === 0) {
    info(yellow("no matching agents"))
    return
  }

  // Figure out which targets actually have context configured.
  const configured: typeof targets = []
  for (const t of targets) {
    try {
      const mcp = await readMcp(t)
      if (mcp) configured.push(t)
    } catch {
      // unreadable config — skip
    }
  }

  if (configured.length === 0) {
    info(dim("context is not configured in any agent — nothing to do"))
    return
  }

  info("Currently configured in:")
  for (const t of configured) {
    info(`  ${green("●")} ${t.name}  ${dim(t.configPath)}`)
  }
  info("")

  const names = configured.map((t) => t.name).join(", ")
  if (!opts.yes && !opts.dryRun) {
    const ok = await confirm(
      `Remove context MCP server from: ${names}?`,
      false,
    )
    if (!ok) {
      info("aborted")
      return
    }
  }

  for (const t of configured) {
    if (opts.dryRun) {
      info(`  ${yellow("would remove")}   ${t.name}`)
      continue
    }
    try {
      const removed = await uninstallMcp(t)
      const tag = removed ? green("removed   ") : dim("not present")
      info(`  ${tag} ${t.name}`)
    } catch (e) {
      info(`  ${red("failed    ")} ${t.name}: ${(e as Error).message}`)
    }
  }

  info("")
  info(dim("Restart your agent(s) so they stop trying to spawn the MCP server."))
  info(
    dim(
      "Your context entries on disk are untouched — delete ~/.nodus/ manually if you also want to remove the data.",
    ),
  )
}
