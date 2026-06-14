import { detectTargets, inspectMcpHealth, readMcp } from "../integrations.js"
import { getBackend } from "../context.js"
import { configPath, getActiveProfile, loadConfig } from "../../config/index.js"
import { bold, cyan, dim, green, info, yellow, red } from "../output.js"
import { getDefaultLocalDir, makeEmbedderFromEnv, type Profile } from "../../backends/index.js"
import { computeMemoryHealth, renderHealthHeadline, type MemoryHealth } from "../../backends/health.js"
import { packageVersion } from "../version.js"
import { refreshUpdateInfo, upgradeCommand } from "../update-check.js"

export interface DoctorArgs {
  json?: boolean
  memory?: boolean
}

export async function cmdDoctor(args: DoctorArgs = {}): Promise<void> {
  if (args.memory) return cmdDoctorMemory(args)
  if (args.json) return cmdDoctorJson()
  info(bold("context"))
  info("")

  // Version line — explicit so users running `doctor` can see at a glance
  // whether they're up to date. `doctor` is the canonical "what's my setup"
  // command, so it gets to spend the network budget to refresh the cache.
  const update = await refreshUpdateInfo()
  if (!update) {
    info(`${dim("version:")} ${packageVersion()}`)
  } else if (update.outdated) {
    info(
      `${dim("version:")} ${packageVersion()}  ${yellow(`→ ${update.latest} available`)}  ${dim(`(${upgradeCommand()})`)}`,
    )
  } else {
    info(`${dim("version:")} ${packageVersion()}  ${dim("(latest)")}`)
  }

  info(`${dim("config:")} ${cyan(configPath())}`)
  let config
  try {
    config = await loadConfig()
  } catch (e) {
    info(red(`config error: ${(e as Error).message}`))
    return
  }
  info(`${dim("profile:")} ${cyan(config.activeProfile)}  ${dim(`(${Object.keys(config.profiles).length} defined)`)}`)
  const activeProfile = config.profiles[config.activeProfile]
  if (activeProfile) {
    info(`${dim("sharing:")} ${sharingLabel(activeProfile)}`)
  }

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

  // Inline memory health summary — gives the user/AI a one-glance read of
  // whether anything needs attention without having to run `--memory`.
  try {
    const backend = await getBackend()
    const health = await computeMemoryHealth(backend)
    if (health.issueCount === 0 && health.acceptedVerifies.length === 0) {
      info(`${dim("memory:")} ${green("clean")}  ${dim(`(${health.totalEntries} entries)`)}`)
    } else {
      const headline = renderHealthHeadline(health) || "no current issues"
      const accepted = health.acceptedVerifies.length > 0 ? `  ${dim(`· ${health.acceptedVerifies.length} accepted`)}` : ""
      const color = health.urgency.urgent > 0 ? red : yellow
      info(`${dim("memory:")} ${color(headline)}${accepted}`)
      info(dim(`  full audit: context doctor --memory`))
    }
    info("")
  } catch (e) {
    // Memory diagnostics are nice-to-have; never fail the doctor over them.
    process.stderr.write(`[context] memory health check failed: ${e instanceof Error ? e.message : String(e)}\n`)
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
    info(`run ${cyan("context init --repair")} to rewrite them to npx.`)
  }
  if (anyStaleRegistration) {
    info("")
    info(yellow("one or more MCP registrations point at an app that isn't installed."))
    info(`remove with ${cyan("context uninstall --only=<id>")}.`)
  }
}

async function renderEmbedderStatus(): Promise<void> {
  const provider = process.env.NODUS_EMBEDDING_PROVIDER
  if (!provider) {
    info(`${dim("search:")} lexical (BM25)  ${dim("(set NODUS_EMBEDDING_PROVIDER=ollama for semantic)")}`)
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
 *
 * Includes the memory-health audit so a single `doctor --json` call gives
 * the agent everything it needs: profile, backend, agents, AND the state
 * of the store (failed verifies, never-checked, duplicates). No need for
 * a second `doctor --memory --json` round-trip.
 */
async function cmdDoctorJson(): Promise<void> {
  const update = await refreshUpdateInfo()
  const result: Record<string, unknown> = {
    version: packageVersion(),
    latestVersion: update?.latest ?? null,
    updateAvailable: update?.outdated ?? false,
    upgradeCommand: update?.outdated ? upgradeCommand() : null,
    configPath: configPath(),
    profile: undefined,
    backend: undefined,
    entries: undefined,
    embedder: undefined,
    agents: [] as unknown[],
    memory: undefined,
    issues: [] as string[],
  }
  try {
    const config = await loadConfig()
    result.profile = {
      active: config.activeProfile,
      defined: Object.keys(config.profiles),
    }
    const active = config.profiles[config.activeProfile]
    result.sharing = active ? sharingJson(active) : undefined
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
    try {
      const health = await computeMemoryHealth(backend)
      result.memory = summarizeHealthForJson(health)
    } catch (e) {
      ;(result.issues as string[]).push(`memory health: ${(e as Error).message}`)
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

function sharingLabel(profile: Profile): string {
  switch (profile.type) {
    case "local":
      return `${green("local")}  ${dim("this device only")}`
    case "http":
      return `${yellow("server")}  ${dim(`${profile.url} · network required`)}`
    case "mirror":
      return `${green("mirror")}  ${dim(`local-first + ${remoteLabel(profile.secondary)}`)}`
    case "module":
      return `${yellow("custom")}  ${dim(profile.path)}`
    default:
      return dim((profile as { type: string }).type)
  }
}

function sharingJson(profile: Profile): Record<string, unknown> {
  switch (profile.type) {
    case "local":
      return { mode: "local", shared: false }
    case "http":
      return { mode: "server", shared: true, url: profile.url }
    case "mirror":
      return { mode: "mirror", shared: true, remote: remoteJson(profile.secondary) }
    case "module":
      return { mode: "custom", shared: undefined, path: profile.path }
    default:
      return { mode: (profile as { type: string }).type }
  }
}

function remoteLabel(profile: Profile): string {
  if (profile.type === "http") return profile.url
  if (profile.type === "mirror") return remoteLabel(profile.secondary)
  return profile.type
}

function remoteJson(profile: Profile): Record<string, unknown> {
  if (profile.type === "http") return { type: "http", url: profile.url, authed: !!profile.token }
  if (profile.type === "mirror") return remoteJson(profile.secondary)
  return { type: profile.type }
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
  if (health.issueCount === 0 && health.acceptedVerifies.length === 0) {
    info(green("no issues — every entry verifies, nothing looks duplicated"))
    return
  }
  if (health.issueCount > 0) {
    const headline = renderHealthHeadline(health)
    const tier =
      health.urgency.urgent > 0
        ? red(`${health.urgency.urgent} urgent`)
        : dim(`${health.urgency.informational} routine`)
    info(`${dim("issues:")} ${headline}  ${dim("·")} ${tier}`)
  }
  info("")

  if (health.failedVerifies.length > 0) {
    info(bold(red(`Failed verifies (${health.failedVerifies.length})`)))
    for (const e of health.failedVerifies) {
      info(`  ${cyan(e.id)}  ${dim(e.verifyMessage ?? "verification failed")}`)
    }
    info(dim(`  re-check:      context verify --failed`))
    info(dim(`  accept (expected): context accept <id> [--reason="..."]`))
    info("")
  }
  if (health.neverVerified.length > 0) {
    info(bold(yellow(`Never verified (${health.neverVerified.length})`)))
    for (const e of health.neverVerified) {
      const spec = e.verify ? `${e.verify.kind}:${e.verify.target}` : ""
      info(`  ${cyan(e.id)}  ${dim(spec)}`)
    }
    info(dim(`  run: context verify --never`))
    info("")
  }
  if (health.staleVerifies.length > 0) {
    info(bold(dim(`Stale verifies (${health.staleVerifies.length})`)))
    for (const e of health.staleVerifies) {
      info(`  ${cyan(e.id)}  ${dim(`last verified ${e.verifiedAt?.slice(0, 10)}`)}`)
    }
    info(dim(`  run: context verify --stale`))
    info("")
  }
  if (health.duplicateClusters.length > 0) {
    info(bold(yellow(`Possible duplicates (${health.duplicateClusters.length})`)))
    for (const cluster of health.duplicateClusters) {
      info(`  ${cluster.ids.map((id) => cyan(id)).join(" ↔ ")}  ${dim(`overlap ${cluster.overlap.toFixed(2)}`)}`)
    }
    const example = health.duplicateClusters[0]
    if (example && example.ids.length >= 2) {
      info(dim(`  merge: context merge ${example.ids[0]} ${example.ids[1]}`))
    }
    info("")
  }
  if (health.acceptedVerifies.length > 0) {
    info(bold(dim(`Accepted (silenced by user) (${health.acceptedVerifies.length})`)))
    for (const e of health.acceptedVerifies) {
      const reason = e.verifyAcceptedReason ? `  ${dim(`— ${e.verifyAcceptedReason}`)}` : ""
      info(`  ${cyan(e.id)}${reason}`)
    }
    info(dim(`  unsuppress: context accept --unaccept <id>`))
    info("")
  }
}

/**
 * Compact shape of memory health for embedding in `doctor --json`. Lists
 * are reduced to id strings so the response stays small even on large stores;
 * full details remain available via `doctor --memory --json`.
 */
function summarizeHealthForJson(health: MemoryHealth) {
  return {
    totalEntries: health.totalEntries,
    issueCount: health.issueCount,
    urgency: health.urgency,
    freshStore: health.freshStore,
    failedVerifies: health.failedVerifies.map((e) => ({ id: e.id, key: e.key, verifyMessage: e.verifyMessage })),
    acceptedVerifies: health.acceptedVerifies.map((e) => ({ id: e.id, reason: e.verifyAcceptedReason ?? null })),
    neverVerified: health.neverVerified.map((e) => ({ id: e.id, key: e.key })),
    staleVerifies: health.staleVerifies.map((e) => ({ id: e.id, key: e.key, verifiedAt: e.verifiedAt })),
    duplicateClusters: health.duplicateClusters.map((c) => ({ ids: c.ids, overlap: c.overlap, key: c.key })),
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
