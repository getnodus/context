import { detectTargets, inspectMcpHealth, readMcp } from "../integrations.js"
import { getBackend } from "../context.js"
import { configPath, getActiveProfile, loadConfig } from "../../config/index.js"
import { bold, cyan, dim, green, info, yellow, red } from "../output.js"
import { getDefaultLocalDir, makeEmbedderFromEnv } from "../../backends/index.js"
import { computeMemoryHealth, renderHealthHeadline } from "../../backends/health.js"

export interface DoctorArgs {
  json?: boolean
  memory?: boolean
}

export async function cmdDoctor(args: DoctorArgs = {}): Promise<void> {
  if (args.memory) return cmdDoctorMemory(args)
  if (args.json) return cmdDoctorJson()
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

  let backendType: string | undefined
  try {
    const backend = await getBackend()
    const desc = backend.describe()
    backendType = desc.type
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

  // For pure-http backends, search is server-side; the local embedder
  // doesn't apply. Showing "search: substring" here just confuses users.
  if (backendType !== "http") {
    await renderEmbedderStatus()
    info("")
  }

  info(bold("Agent integrations"))
  const targets = await detectTargets()
  const nameWidth = Math.max(16, ...targets.map((t) => t.name.length + 1))
  let anyBroken = false
  let anyStaleRegistration = false
  for (const t of targets) {
    const detection = t.detected ? green("●") : dim("○")
    let status: string
    let extra: string | undefined
    try {
      const mcp = await readMcp(t)
      if (mcp) {
        const health = await inspectMcpHealth(mcp)
        const cmdLine = `${mcp.command} ${mcp.args.join(" ")}`
        if (health.kind === "node-file" && !health.fileExists) {
          anyBroken = true
          status = red("broken") + dim(` (${cmdLine})`)
          extra = red(`    missing file: ${health.filePath}`)
        } else if (!t.detected) {
          // App isn't installed but a config entry exists — usually left
          // over from a past install. Nothing will ever read it.
          anyStaleRegistration = true
          status = yellow("stale") + dim(` (app not installed — ${cmdLine})`)
        } else {
          status = green("configured") + dim(` (${cmdLine})`)
        }
      } else if (t.detected) {
        status = yellow("not configured")
      } else {
        status = dim("not installed")
      }
    } catch (e) {
      status = red(`error: ${(e as Error).message}`)
    }
    info(`  ${detection} ${t.name.padEnd(nameWidth)} ${status}`)
    info(`    ${dim(t.configPath)}`)
    if (extra) info(extra)
  }

  if (anyBroken) {
    info("")
    info(yellow("one or more MCP installs reference a file that no longer exists."))
    info(`run ${cyan("nodus-context init --repair")} to rewrite them to npx.`)
  }
  if (anyStaleRegistration) {
    info("")
    info(yellow("one or more MCP registrations point at an app that isn't installed."))
    info(`remove with ${cyan("nodus-context uninstall --only=<id>")}.`)
  }
}

async function renderEmbedderStatus(): Promise<void> {
  const provider = process.env.NODUS_EMBEDDING_PROVIDER
  if (!provider) {
    info(`${dim("search:")} substring  ${dim("(set NODUS_EMBEDDING_PROVIDER=ollama for semantic)")}`)
    return
  }
  let embedder
  try {
    embedder = makeEmbedderFromEnv()
  } catch (e) {
    info(`${dim("search:")} ${red("misconfigured")}  ${dim((e as Error).message)}`)
    return
  }
  if (!embedder) {
    info(`${dim("search:")} substring`)
    return
  }
  process.stderr.write(`${dim("search:")} semantic via ${embedder.id}  `)
  try {
    await embedder.embed("ping")
    process.stderr.write(green("reachable") + "\n")
  } catch (e) {
    process.stderr.write(red("unreachable") + dim(` — falling back to substring (${(e as Error).message.slice(0, 80)})`) + "\n")
  }
}

/**
 * Machine-readable doctor output. Same data as the textual version but
 * shaped for programmatic consumption — designed for AI assistants
 * diagnosing setup state before recommending next actions.
 */
async function cmdDoctorJson(): Promise<void> {
  const result: Record<string, unknown> = {
    configPath: configPath(),
    profile: undefined,
    backend: undefined,
    entries: undefined,
    embedder: undefined,
    agents: [] as unknown[],
    issues: [] as string[],
  }
  try {
    const config = await loadConfig()
    result.profile = {
      active: config.activeProfile,
      defined: Object.keys(config.profiles),
    }
  } catch (e) {
    ;(result.issues as string[]).push(`config: ${(e as Error).message}`)
  }
  let backendType: string | undefined
  try {
    const backend = await getBackend()
    const desc = backend.describe()
    backendType = desc.type
    result.backend = {
      type: desc.type,
      label: desc.label,
      capabilities: desc.capabilities,
    }
    try {
      const all = await backend.list()
      result.entries = all.length
    } catch (e) {
      ;(result.issues as string[]).push(`backend unreachable: ${(e as Error).message}`)
    }
  } catch (e) {
    ;(result.issues as string[]).push(`backend: ${(e as Error).message}`)
  }
  // Embedder — only relevant when local content is searched on this
  // machine. Pure-http backends defer to the server.
  const provider = process.env.NODUS_EMBEDDING_PROVIDER
  if (backendType === "http") {
    result.embedder = { applicable: false, reason: "server-side search" }
  } else if (!provider) {
    result.embedder = { configured: false, mode: "substring" }
  } else {
    try {
      const embedder = makeEmbedderFromEnv()
      if (!embedder) {
        result.embedder = { configured: false, mode: "substring" }
      } else {
        let reachable = true
        let error: string | undefined
        try {
          await embedder.embed("ping")
        } catch (e) {
          reachable = false
          error = (e as Error).message
        }
        result.embedder = { configured: true, id: embedder.id, reachable, ...(error ? { error } : {}) }
      }
    } catch (e) {
      result.embedder = { configured: false, mode: "substring", error: (e as Error).message }
    }
  }
  // Agents
  const agentsOut: Array<Record<string, unknown>> = []
  for (const t of await detectTargets()) {
    let installed = false
    let cmdInfo: unknown
    let healthInfo: unknown
    try {
      const mcp = await readMcp(t)
      if (mcp) {
        installed = true
        const h = await inspectMcpHealth(mcp)
        cmdInfo = { command: mcp.command, args: mcp.args }
        healthInfo = h
        if (h.kind === "node-file" && !h.fileExists) {
          ;(result.issues as string[]).push(`${t.id}: broken install (missing file ${h.filePath})`)
        }
        if (!t.detected) {
          ;(result.issues as string[]).push(`${t.id}: stale registration (app not installed)`)
        }
      }
    } catch (e) {
      ;(result.issues as string[]).push(`${t.id}: ${(e as Error).message}`)
    }
    agentsOut.push({
      id: t.id,
      name: t.name,
      source: t.source,
      detected: t.detected,
      configPath: t.configPath,
      installed,
      command: cmdInfo,
      health: healthInfo,
    })
  }
  result.agents = agentsOut
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}

/**
 * `doctor --memory` — explicit audit of the store. Surfaces what's been
 * accumulating quietly: failed verifies, never-checked entries, near-duplicates.
 * Read-only; nothing is mutated.
 */
async function cmdDoctorMemory(args: DoctorArgs): Promise<void> {
  const backend = await getBackend()
  const health = await computeMemoryHealth(backend)

  if (args.json) {
    process.stdout.write(JSON.stringify(health, null, 2) + "\n")
    return
  }

  info(bold("Memory health"))
  info(`${dim("entries:")} ${health.totalEntries}`)
  if (health.issueCount === 0) {
    info(green("no issues — every entry verifies, nothing looks duplicated"))
    return
  }
  info(`${dim("issues:")} ${renderHealthHeadline(health)}`)
  info("")

  if (health.failedVerifies.length > 0) {
    info(bold(red(`Failed verifies (${health.failedVerifies.length})`)))
    for (const e of health.failedVerifies) {
      info(`  ${cyan(e.id)}  ${dim(e.verifyMessage ?? "verification failed")}`)
    }
    info("")
  }
  if (health.neverVerified.length > 0) {
    info(bold(yellow(`Never verified (${health.neverVerified.length})`)))
    for (const e of health.neverVerified) {
      const spec = e.verify ? `${e.verify.kind}:${e.verify.target}` : ""
      info(`  ${cyan(e.id)}  ${dim(spec)}`)
    }
    info(dim(`  run: nodus-context verify --all`))
    info("")
  }
  if (health.staleVerifies.length > 0) {
    info(bold(dim(`Stale verifies (${health.staleVerifies.length})`)))
    for (const e of health.staleVerifies) {
      info(`  ${cyan(e.id)}  ${dim(`last verified ${e.verifiedAt?.slice(0, 10)}`)}`)
    }
    info("")
  }
  if (health.duplicateClusters.length > 0) {
    info(bold(yellow(`Possible duplicates (${health.duplicateClusters.length})`)))
    for (const cluster of health.duplicateClusters) {
      info(`  ${cluster.ids.map((id) => cyan(id)).join(" ↔ ")}  ${dim(`overlap ${cluster.overlap.toFixed(2)}`)}`)
    }
    info(dim(`  review and merge with: nodus-context show <id> + nodus-context add <id> --supersedes=<old>`))
    info("")
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
