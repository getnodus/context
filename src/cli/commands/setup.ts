import { loadConfig, saveConfig } from "../../config/index.js"
import {
  detectTargets,
  installMcp,
  mcpCommand,
  type AgentTarget,
} from "../integrations.js"
import { type Profile } from "../../backends/index.js"
import { bold, cyan, dim, fail, green, info, printRestartHint, red, yellow } from "../output.js"
import { decodePairing, isPairingString } from "../../server/pairing.js"

export interface SetupArgs {
  backend?: "local" | "server" | "mirror"
  /** Server URL or pairing string. Required when backend is server/mirror. */
  url?: string
  token?: string
  /**
   * Agents to install for. Accepts:
   *   - "detected" (default) — every agent the registry detects on this machine
   *   - "all" — every known agent, even ones not detected
   *   - "none" — write the profile, install nothing
   *   - comma-separated ids ("claude-code,codex-cli")
   */
  agents?: string
  /** Profile name to write. Defaults follow backend type. */
  profile?: string
  json?: boolean
}

interface SetupResult {
  ok: boolean
  profile: { name: string; type: string; url?: string; authed?: boolean }
  agents: {
    installed: { id: string; status: "installed" | "updated" | "already-installed" }[]
    failed: { id: string; error: string }[]
    skipped: { id: string; reason: string }[]
  }
  notes: string[]
}

/**
 * Non-interactive, all-flag setup — the AI-friendly entry point.
 *
 * Wraps the wizard's logic in a single deterministic command that takes
 * everything via flags and emits a structured result. Designed to be
 * called by Claude, Codex, or any other agent helping a human onboard
 * without making the human watch a TUI.
 *
 * Idempotent: re-running with the same flags is safe; profile and agent
 * registrations are overwritten in place, not duplicated.
 */
export async function cmdSetup(args: SetupArgs): Promise<void> {
  const backend = args.backend ?? "local"

  // ----- profile -----
  let profile: Profile
  let profileName = args.profile ?? defaultProfileName(backend)
  const notes: string[] = []
  let serverUrl: string | undefined
  let serverToken: string | undefined

  if (backend === "server" || backend === "mirror") {
    if (!args.url) {
      fail(`setup: --url is required for backend=${backend}`)
    }
    if (isPairingString(args.url!)) {
      const decoded = decodePairing(args.url!)
      serverUrl = decoded.url
      serverToken = decoded.token ?? args.token
      if (args.token && decoded.token && args.token !== decoded.token) {
        notes.push("--token overrides the token from the pairing string")
        serverToken = args.token
      }
    } else {
      serverUrl = args.url
      serverToken = args.token
    }
  }

  switch (backend) {
    case "local":
      profile = { type: "local" }
      break
    case "server":
      profile = {
        type: "http",
        url: serverUrl!,
        ...(serverToken ? { token: serverToken } : {}),
      }
      break
    case "mirror":
      profile = {
        type: "mirror",
        primary: { type: "local" },
        secondary: {
          type: "http",
          url: serverUrl!,
          ...(serverToken ? { token: serverToken } : {}),
        },
      }
      break
    default:
      fail(`setup: unknown backend "${backend}" (expected local | server | mirror)`)
  }

  const config = await loadConfig()
  config.profiles[profileName] = profile!
  config.activeProfile = profileName
  await saveConfig(config)

  // ----- agents -----
  const all = await detectTargets()
  const agentsArg = args.agents ?? "detected"
  let chosen: AgentTarget[]
  const skipped: SetupResult["agents"]["skipped"] = []

  if (agentsArg === "none") {
    chosen = []
  } else if (agentsArg === "detected") {
    chosen = all.filter((t) => t.detected)
    for (const t of all) {
      if (!t.detected) skipped.push({ id: t.id, reason: "not installed on this machine" })
    }
  } else if (agentsArg === "all") {
    chosen = all
  } else {
    const requested = new Set(agentsArg.split(",").map((s) => s.trim()).filter(Boolean))
    chosen = all.filter((t) => requested.has(t.id))
    for (const id of requested) {
      if (!all.some((t) => t.id === id)) {
        skipped.push({ id, reason: "unknown agent id" })
      }
    }
    for (const t of all) {
      if (!requested.has(t.id)) skipped.push({ id: t.id, reason: "not selected" })
    }
  }

  const installed: SetupResult["agents"]["installed"] = []
  const failed: SetupResult["agents"]["failed"] = []
  const cmd = mcpCommand()
  for (const target of chosen) {
    try {
      const r = await installMcp(target, cmd)
      installed.push({ id: target.id, status: r.status })
    } catch (e) {
      failed.push({ id: target.id, error: (e as Error).message })
    }
  }

  const result: SetupResult = {
    ok: failed.length === 0,
    profile: {
      name: profileName,
      type: profile!.type,
      ...(serverUrl ? { url: serverUrl } : {}),
      ...(serverUrl ? { authed: !!serverToken } : {}),
    },
    agents: { installed, failed, skipped },
    notes: [
      ...notes,
      ...(installed.length > 0
        ? [
            "restart each installed agent to load the new MCP server: quit and relaunch GUI apps (Claude Desktop, Cursor, Cline, Windsurf, Zed); start a new session for CLI agents (Claude Code, Codex CLI)",
          ]
        : []),
    ],
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    if (!result.ok) process.exit(1)
    return
  }

  info(bold("\nnodus-context setup"))
  info(`  ${dim("profile  →")} ${cyan(profileName)} ${dim(`(${profile!.type})`)}`)
  if (serverUrl) info(`  ${dim("url      →")} ${cyan(serverUrl)}${serverToken ? dim(" (auth)") : ""}`)
  for (const a of installed) {
    info(`  ${green(a.status.padEnd(18))} ${a.id}`)
  }
  for (const s of skipped) {
    info(`  ${dim("skipped".padEnd(18))} ${s.id}  ${dim(s.reason)}`)
  }
  for (const f of failed) {
    info(`  ${red("failed".padEnd(18))} ${f.id}: ${f.error}`)
  }
  for (const n of notes) info(yellow(`  · ${n}`))
  if (installed.length > 0) printRestartHint()
  if (!result.ok) process.exit(1)
}

function defaultProfileName(backend: SetupArgs["backend"]): string {
  switch (backend) {
    case "server":
      return "server"
    case "mirror":
      return "cloud"
    case "local":
    default:
      return "default"
  }
}
