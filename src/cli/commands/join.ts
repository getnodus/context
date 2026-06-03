import { decodePairing } from "../../server/pairing.js"
import { loadConfig, saveConfig } from "../../config/index.js"
import { bold, cyan, dim, fail, green, info, printRestartHint, red } from "../output.js"
import { detectTargets, installMcp, mcpCommand } from "../integrations.js"
import { type Profile, type ProfileHttp } from "../../backends/index.js"
import { probeRemote, reconcileProfileWithRemote } from "../shared-memory.js"

export interface JoinArgs {
  pairingString: string
  /** Profile name to write. Defaults to "cloud". */
  name?: string
  /** Skip MCP install on detected agents (just write the profile). */
  noInstall?: boolean
  /** JSON output for AI consumption. */
  json?: boolean
}

interface JoinResult {
  ok: boolean
  profile: string
  type: "mirror"
  url: string
  authed: boolean
  configured: boolean
  installed: string[]
  failed: { id: string; error: string }[]
  reachable: boolean
  initialSync?: { copied: number; failed: number; skipped: number }
  error?: string
}

/**
 * One-shot client-side onboarding: paste a pairing string, get configured.
 *
 * Equivalent to: profile add --type=mirror --url=... --token=... --use,
 * then install for detected agents. Idempotent — re-running overwrites the same profile
 * name rather than accumulating.
 */
export async function cmdJoin(args: JoinArgs): Promise<void> {
  let pairing
  try {
    pairing = decodePairing(args.pairingString)
  } catch (e) {
    fail((e as Error).message)
  }

  const probeResult = await probeRemote(pairing!.url, pairing!.token)
  const profileName = args.name ?? "cloud"
  const result: JoinResult = {
    ok: probeResult.ok,
    profile: profileName,
    type: "mirror",
    url: pairing!.url,
    authed: !!pairing!.token,
    configured: false,
    installed: [],
    failed: [],
    reachable: probeResult.reachable,
    ...(probeResult.error ? { error: probeResult.error } : {}),
  }

  if (!probeResult.ok) {
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      process.exit(1)
    }
    info(bold("context join"))
    info(`  ${dim("url      →")} ${cyan(pairing!.url)}${pairing!.token ? dim(" (auth)") : ""}`)
    info(`  ${dim("reachable→")} ${probeResult.reachable ? green("yes") : red("no")}`)
    info(red(`  not configured: ${probeResult.error ?? "server probe failed"}`))
    return
  }

  const config = await loadConfig()
  const previousProfileName = config.activeProfile
  const previousProfile = config.profiles[previousProfileName]
  const secondaryProfile: ProfileHttp = {
    type: "http",
    url: pairing!.url,
    ...(pairing!.token ? { token: pairing!.token } : {}),
  }
  const mirrorProfile: Profile = {
    type: "mirror",
    primary: { type: "local" },
    secondary: secondaryProfile,
  }

  if (previousProfile) {
    try {
      result.initialSync = await reconcileProfileWithRemote(previousProfile, secondaryProfile)
    } catch (e) {
      result.ok = false
      result.initialSync = { copied: 0, failed: 1, skipped: 0 }
      result.error = `initial sync failed: ${(e as Error).message}`
      if (args.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n")
        process.exit(1)
      }
      info(bold("context join"))
      info(`  ${dim("profile  →")} ${cyan(profileName)} ${dim("(mirror)")}`)
      info(`  ${dim("url      →")} ${cyan(pairing!.url)}${pairing!.token ? dim(" (auth)") : ""}`)
      info(`  ${dim("reachable→")} ${green("yes")}`)
      info(red(`  not configured: ${result.error}`))
      process.exit(1)
    }
  }

  config.profiles[profileName] = mirrorProfile
  config.activeProfile = profileName
  await saveConfig(config)
  result.configured = true

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

  info(bold("context join"))
  info(`  ${dim("profile  →")} ${cyan(profileName)} ${dim("(mirror, active)")}`)
  info(`  ${dim("url      →")} ${cyan(pairing!.url)}${pairing!.token ? dim(" (auth)") : ""}`)
  info(`  ${dim("reachable→")} ${probeResult.reachable ? green("yes") : red("no")}`)
  if (result.installed.length > 0) {
    info(`  ${dim("installed→")} ${green(result.installed.join(", "))}`)
  }
  if (result.initialSync) {
    const syncText = `${result.initialSync.copied} copied, ${result.initialSync.skipped} already in sync`
    info(`  ${dim("sync     →")} ${result.initialSync.failed > 0 ? red(syncText + `, ${result.initialSync.failed} failed`) : green(syncText)}`)
  }
  for (const f of result.failed) {
    info(`  ${red("failed   ")} ${f.id}: ${f.error}`)
  }
  if (result.installed.length > 0) {
    printRestartHint()
  }
}
