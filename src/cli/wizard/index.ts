import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { ask, askSecret, confirm, selectMany, selectOne } from "./prompt.js"
import { discover, type DiscoveredServer } from "../../server/discovery.js"
import { decodePairing, isPairingString } from "../../server/pairing.js"
import {
  detectTargets,
  installMcp,
  localMcpCommand,
  mcpCommand,
  type AgentTarget,
  type McpServerConfig,
} from "../integrations.js"
import { loadConfig, saveConfig } from "../../config/index.js"
import { type Profile } from "../../backends/index.js"
import { bold, cyan, dim, green, info, red, yellow } from "../output.js"
import { packageVersion } from "../version.js"

export interface WizardOptions {
  /** Skip the wizard entirely and run the legacy auto-install. */
  yes?: boolean
}

type BackendChoice = "local" | "server" | "mirror"

/**
 * Interactive setup wizard. Walks the user through:
 *   1. Backend choice (local / remote server / mirror)
 *   2. If remote/mirror: URL + token, reachability probe
 *   3. Agent multi-select (defaults: all detected, none undetected)
 *   4. Review + confirm
 *   5. Apply: write profile, install MCP into each chosen agent
 *
 * Designed to be safe to re-run — overwrites the same profile name
 * ("default" or "server") rather than accumulating profiles. Anything
 * the user already had is preserved unless explicitly chosen otherwise.
 */
export async function runWizard(_opts: WizardOptions = {}): Promise<void> {
  banner()

  // ----- Step 1: backend choice -----
  const backendChoice = await selectOne<BackendChoice>(
    "Where should your context live?",
    [
      {
        value: "local",
        label: "Local files on this machine",
        hint: "~/.nodus/context · works offline · default",
      },
      {
        value: "server",
        label: "Remote server (pure HTTP)",
        hint: "you provide URL + token · multi-device · needs network",
      },
      {
        value: "mirror",
        label: "Both — local-first, mirrored to server",
        hint: "fast offline reads, durable across devices · recommended",
      },
    ],
    0,
  )

  // ----- Step 2: server details (if needed) -----
  let serverUrl: string | undefined
  let serverToken: string | undefined
  if (backendChoice === "server" || backendChoice === "mirror") {
    info(bold("\nServer details"))
    info(dim("  paste a pairing string (nodus://…) or pick from below"))
    serverUrl = await pickServerUrl()
    // Pairing strings carry the token inline — short-circuit the "needs
    // token?" prompt when we already have one.
    if (isPairingString(serverUrl)) {
      const decoded = decodePairing(serverUrl)
      serverUrl = decoded.url
      serverToken = decoded.token
      info(dim(`  → ${cyan(serverUrl)}${decoded.token ? dim(" (token from pairing)") : ""}`))
    } else {
      const wantToken = await confirm("Does the server require a token?", true)
      if (wantToken) {
        serverToken = await askSecret("Token (hidden)")
      }
    }
    const ok = await probeServer(serverUrl, serverToken)
    if (!ok) {
      const proceed = await confirm(
        red("server didn't respond — save profile anyway?"),
        false,
      )
      if (!proceed) {
        info(yellow("aborted; nothing written"))
        return
      }
    }
  }

  // ----- Step 3: agents -----
  info(bold("\nDetected agents"))
  const targets = await detectTargets()
  const detected = targets.filter((t) => t.detected)
  const undetected = targets.filter((t) => !t.detected)

  if (detected.length === 0 && undetected.length === 0) {
    info(yellow("no agents known"))
    return
  }

  const choices = [
    ...detected.map((t) => ({ value: t.id, label: t.name, hint: hintFor(t, true) })),
    ...undetected.map((t) => ({ value: t.id, label: t.name, hint: hintFor(t, false) })),
  ]
  const detectedSet = new Set(detected.map((t) => t.id))
  const chosenIds = await selectMany(
    "Which agents should I install for?",
    choices,
    (c) => detectedSet.has(c.value),
  )
  const chosen = targets.filter((t) => chosenIds.includes(t.id))

  // ----- Step 4: review -----
  info(bold("\nReview"))
  info(`  ${dim("Profile  →")} ${cyan(describeBackend(backendChoice, serverUrl))}`)
  info(`  ${dim("Agents   →")} ${cyan(chosen.map((c) => c.name).join(", ") || "(none)")}`)
  if (serverUrl) info(`  ${dim("Server   →")} ${cyan(serverUrl)}${serverToken ? dim(" (auth)") : ""}`)
  const proceed = await confirm("\nProceed?", true)
  if (!proceed) {
    info(yellow("aborted; nothing written"))
    return
  }

  // ----- Step 5: apply -----
  await applyBackend(backendChoice, serverUrl, serverToken)
  await applyAgents(chosen)

  info(green("\n✓ done."))
  info(dim("Restart your agent(s) so they pick up the new MCP server."))
}

function banner(): void {
  info(bold(`\nnodus-context setup  ${dim(`v${packageVersion()}`)}`))
  info(dim("Personal context layer for AI agents. Press Ctrl+C any time to cancel.\n"))
}

function describeBackend(choice: BackendChoice, url?: string): string {
  switch (choice) {
    case "local":
      return "local files (~/.nodus/context)"
    case "server":
      return `remote http (${url})`
    case "mirror":
      return `mirror — local + remote (${url})`
  }
}

function hintFor(t: AgentTarget, detected: boolean): string {
  if (!detected) return "not installed (skip)"
  const installType = t.definition.install.type
  return installType === "cli-mcp"
    ? `${(t.definition.install as { binary: string }).binary} mcp add`
    : t.configPath
}

/**
 * Pick a server URL. First scans the LAN via mDNS for ~3s; if any servers
 * are found, presents them as choices alongside "Enter URL manually". If
 * nothing's found (or the user picks manual), falls through to a plain
 * URL prompt.
 *
 * mDNS is LAN-local. Tailscale and other overlay networks don't forward
 * multicast, so cross-tailnet servers won't appear here — that's noted
 * to the user only when the scan returns empty, to avoid noise.
 */
async function pickServerUrl(): Promise<string> {
  process.stderr.write(dim("  scanning local network for nodus-context servers… "))
  let found: DiscoveredServer[] = []
  try {
    found = await discover({ timeoutMs: 3000 })
  } catch {
    // multicast bind failed; treat as no results
  }
  process.stderr.write(found.length === 0 ? dim("none found\n") : dim(`${found.length} found\n`))

  if (found.length === 0) {
    info(dim("  (tip: mDNS is LAN-only; cross-Tailscale/VPN servers won't show up here)"))
    return ask("Server URL", { default: "http://127.0.0.1:7475" })
  }

  const MANUAL = "__manual__"
  const pick = await selectOne<string>(
    "Select a server",
    [
      ...found.map((s) => ({
        value: s.url,
        label: `${s.name}  ${dim(s.url)}`,
        hint: s.txt.version ? `v${s.txt.version}${s.txt.auth === "bearer" ? " · token required" : ""}` : undefined,
      })),
      { value: MANUAL, label: "Enter URL manually" },
    ],
    0,
  )
  if (pick === MANUAL) {
    return ask("Server URL", { default: "http://127.0.0.1:7475" })
  }
  return pick
}

async function probeServer(url: string, token?: string): Promise<boolean> {
  process.stderr.write(dim("  probing… "))
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(url.replace(/\/+$/, "") + "/", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer))
    if (res.status === 401) {
      process.stderr.write(red("unauthorized") + dim(" (token rejected)\n"))
      return false
    }
    if (!res.ok) {
      process.stderr.write(red(`status ${res.status}\n`))
      return false
    }
    const data = (await res.json()) as { protocolVersion?: number; version?: string }
    process.stderr.write(
      green("ok") +
        dim(` — protocol v${data.protocolVersion ?? "?"}${data.version ? `, server ${data.version}` : ""}\n`),
    )
    return true
  } catch (e) {
    process.stderr.write(red(`unreachable`) + dim(` (${(e as Error).message})\n`))
    return false
  }
}

async function applyBackend(
  choice: BackendChoice,
  url?: string,
  token?: string,
): Promise<void> {
  const config = await loadConfig()
  let profile: Profile
  let name: string
  switch (choice) {
    case "local":
      profile = { type: "local" }
      name = "default"
      break
    case "server":
      if (!url) throw new Error("server backend requires URL")
      profile = { type: "http", url, ...(token ? { token } : {}) }
      name = "server"
      break
    case "mirror":
      if (!url) throw new Error("mirror backend requires URL")
      profile = {
        type: "mirror",
        primary: { type: "local" },
        secondary: { type: "http", url, ...(token ? { token } : {}) },
      }
      name = "cloud"
      break
  }
  config.profiles[name] = profile
  config.activeProfile = name
  await saveConfig(config)
  info(`  ${green("✓")} profile ${cyan(name)} ${dim(`(${profile.type})`)} → active`)
}

async function applyAgents(chosen: AgentTarget[]): Promise<void> {
  if (chosen.length === 0) return
  const cmd: McpServerConfig = mcpCommand()
  for (const target of chosen) {
    try {
      const result = await installMcp(target, cmd)
      const via =
        target.definition.install.type === "cli-mcp"
          ? dim(` (via ${(target.definition.install as { binary: string }).binary} mcp add)`)
          : ""
      const tag =
        result.status === "installed"
          ? green("installed")
          : result.status === "updated"
            ? yellow("updated  ")
            : dim("already   ")
      info(`  ${tag} ${target.name}${via}`)
    } catch (e) {
      info(`  ${red("failed   ")} ${target.name}: ${(e as Error).message}`)
    }
  }
}

// Keep --local available so power users can still pin a local file path.
export function resolveLocalServerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..", "..", "mcp", "server.js")
}

export { localMcpCommand }
