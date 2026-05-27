import { detectTargets, readMcp } from "../integrations.js"
import { getBackend } from "../context.js"
import { configPath, getActiveProfile, loadConfig } from "../../config/index.js"
import { bold, cyan, dim, green, info, yellow, red } from "../output.js"
import { getDefaultLocalDir } from "../../backends/index.js"

export async function cmdDoctor(): Promise<void> {
  info(bold("nodus-context"))
  info("")

  info(`${dim("config:")} ${cyan(configPath())}`)
  let config
  try {
    config = await loadConfig()
  } catch (e) {
    info(red(`config error: ${(e as Error).message}`))
    return
  }
  info(`${dim("profile:")} ${cyan(config.activeProfile)}  ${dim(`(${Object.keys(config.profiles).length} defined)`)}`)

  try {
    const backend = await getBackend()
    const desc = backend.describe()
    info(`${dim("backend:")} ${desc.type}  ${dim(desc.label)}`)
    info(`${dim("history:")} ${desc.capabilities.history ? green("yes") : dim("no")}`)
    try {
      const entries = await backend.list({ limit: 1 })
      const total = await backend.list()
      info(`${dim("entries:")} ${total.length}`)
    } catch (e) {
      info(red(`backend unreachable: ${(e as Error).message}`))
    }
  } catch (e) {
    info(red(`could not load backend: ${(e as Error).message}`))
  }
  info("")

  info(bold("Agent integrations"))
  const targets = await detectTargets()
  for (const t of targets) {
    const detection = t.detected ? green("●") : dim("○")
    let status: string
    try {
      const mcp = await readMcp(t)
      if (mcp) {
        status = green(`configured`) + dim(` (${mcp.command} ${mcp.args.join(" ")})`)
      } else if (t.detected) {
        status = yellow("not configured")
      } else {
        status = dim("not installed")
      }
    } catch (e) {
      status = red(`error: ${(e as Error).message}`)
    }
    info(`  ${detection} ${t.name.padEnd(16)} ${status}`)
    info(`    ${dim(t.configPath)}`)
  }
}

export async function cmdPath(id?: string): Promise<void> {
  // Path is meaningful only for the local backend. Always print the local dir
  // even when a non-local profile is active — it's where local fallback would live.
  const root = getDefaultLocalDir()
  if (!id) {
    process.stdout.write(root + "\n")
    return
  }
  process.stdout.write(`${root}/${id}.md\n`)
}
