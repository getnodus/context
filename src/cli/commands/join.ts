import { decodePairing } from "../../server/pairing.js"
import { loadConfig, saveConfig } from "../../config/index.js"
import { bold, cyan, dim, fail, green, info, printRestartHint, red, yellow } from "../output.js"
import { detectTargets, installMcp, mcpCommand } from "../integrations.js"

export interface JoinArgs {
  pairingString: string
  /** Profile name to write. Defaults to "server". */
  name?: string
  /** Skip MCP install on detected agents (just write the profile). */
  noInstall?: boolean
  /** JSON output for AI consumption. */
  json?: boolean
}

interface JoinResult {
  profile: string
  url: string
  authed: boolean
  installed: string[]
  failed: { id: string; error: string }[]
  reachable: boolean
}

/**
 * One-shot client-side onboarding: paste a pairing string, get configured.
 *
 * Equivalent to: profile add --type=http --url=... --token=... --use,
 * then init --yes. Idempotent — re-running overwrites the same profile
 * name rather than accumulating.
 */
export async function cmdJoin(args: JoinArgs): Promise<void> {
  let pairing
  try {
    pairing = decodePairing(args.pairingString)
  } catch (e) {
    fail((e as Error).message)
  }

  const profileName = args.name ?? "server"
  const config = await loadConfig()
  config.profiles[profileName] = {
    type: "http",
    url: pairing!.url,
    ...(pairing!.token ? { token: pairing!.token } : {}),
  }
  config.activeProfile = profileName
  await saveConfig(config)

  const reachable = await probe(pairing!.url, pairing!.token)
  const result: JoinResult = {
    profile: profileName,
    url: pairing!.url,
    authed: !!pairing!.token,
    installed: [],
    failed: [],
    reachable,
  }

  if (!args.noInstall) {
    const targets = (await detectTargets()).filter((t) => t.detected)
    const cmd = mcpCommand()
    for (const t of targets) {
      try {
        await installMcp(t, cmd)
        result.installed.push(t.id)
      } catch (e) {
        result.failed.push({ id: t.id, error: (e as Error).message })
      }
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return
  }

  info(bold("nodus-context join"))
  info(`  ${dim("profile  →")} ${cyan(profileName)} ${dim("(active)")}`)
  info(`  ${dim("url      →")} ${cyan(pairing!.url)}${pairing!.token ? dim(" (auth)") : ""}`)
  info(`  ${dim("reachable→")} ${reachable ? green("yes") : red("no")}`)
  if (result.installed.length > 0) {
    info(`  ${dim("installed→")} ${green(result.installed.join(", "))}`)
  }
  for (const f of result.failed) {
    info(`  ${red("failed   ")} ${f.id}: ${f.error}`)
  }
  if (!reachable) {
    info(yellow("server didn't respond. profile saved; verify URL and try again."))
  } else if (result.installed.length > 0) {
    printRestartHint()
  }
}

async function probe(url: string, token?: string): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    })
    return res.ok || res.status === 401 || res.status === 403
    // 401/403 still mean the server is reachable; the token may be wrong.
    // We surface "reachable: true" so the user knows it's online; auth
    // failure shows up at first real read/write.
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
