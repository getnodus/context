import { loadConfig, saveConfig, NodusConfig } from "../../config/index.js"
import { bold, cyan, dim, fail, green, info, yellow } from "../output.js"
import { Profile } from "../../backends/index.js"
import { confirm } from "../prompt.js"

export async function cmdProfileList(args: { json?: boolean }): Promise<void> {
  const config = await loadConfig()
  if (args.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n")
    return
  }
  info(bold("profiles"))
  for (const [name, profile] of Object.entries(config.profiles)) {
    const marker = name === config.activeProfile ? green("●") : dim("○")
    info(`  ${marker} ${cyan(name.padEnd(16))} ${dim(describe(profile))}`)
  }
  info("")
  info(dim(`active: ${config.activeProfile}`))
  info(dim(`switch with: nodus-context use <name>`))
}

export interface ProfileAddArgs {
  name: string
  type: string
  url?: string
  token?: string
  rootDir?: string
  path?: string
  options?: string
  use?: boolean
}

export async function cmdProfileAdd(args: ProfileAddArgs): Promise<void> {
  const config = await loadConfig()
  if (config.profiles[args.name] && !(await confirm(`profile "${args.name}" exists. overwrite?`, false))) {
    info("aborted")
    return
  }

  let profile: Profile
  switch (args.type) {
    case "local":
      profile = { type: "local", ...(args.rootDir ? { rootDir: args.rootDir } : {}) }
      break
    case "http":
      if (!args.url) fail("--url required for http backend")
      profile = {
        type: "http",
        url: args.url,
        ...(args.token ? { token: args.token } : {}),
      }
      break
    case "module": {
      if (!args.path) fail("--path required for module backend")
      let parsedOptions: unknown = undefined
      if (args.options) {
        try {
          parsedOptions = JSON.parse(args.options)
        } catch (e) {
          fail(`--options must be valid JSON: ${(e as Error).message}`)
        }
      }
      profile = { type: "module", path: args.path, options: parsedOptions }
      break
    }
    default:
      fail(`unknown backend type: ${args.type} (expected local, http, or module)`)
  }

  config.profiles[args.name] = profile
  if (args.use) config.activeProfile = args.name
  await saveConfig(config)
  info(`${green("added")} profile ${cyan(args.name)} ${dim(`(${args.type})`)}`)
  if (args.use) info(`${green("active")} → ${cyan(args.name)}`)
}

export async function cmdProfileRemove(args: { name: string }): Promise<void> {
  const config = await loadConfig()
  if (!config.profiles[args.name]) fail(`no profile "${args.name}"`)
  if (Object.keys(config.profiles).length === 1) fail("can't remove the only profile")
  delete config.profiles[args.name]
  if (config.activeProfile === args.name) {
    config.activeProfile = Object.keys(config.profiles)[0]
    info(yellow(`active profile was "${args.name}" — switched to "${config.activeProfile}"`))
  }
  await saveConfig(config)
  info(`${green("removed")} profile ${cyan(args.name)}`)
}

export async function cmdUse(args: { name: string }): Promise<void> {
  const config = await loadConfig()
  if (!config.profiles[args.name]) {
    fail(`no profile "${args.name}". list with: nodus-context profile list`)
  }
  config.activeProfile = args.name
  await saveConfig(config)
  info(`${green("active")} → ${cyan(args.name)} ${dim(describe(config.profiles[args.name]))}`)
}

export async function cmdConfigShow(args: { json?: boolean }): Promise<void> {
  const config = await loadConfig()
  if (args.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n")
    return
  }
  process.stdout.write(JSON.stringify(config, null, 2) + "\n")
}

export async function cmdConfigPath(): Promise<void> {
  const { configPath } = await import("../../config/index.js")
  process.stdout.write(configPath() + "\n")
}

function describe(profile: Profile): string {
  switch (profile.type) {
    case "local":
      return `local${profile.rootDir ? ` ${profile.rootDir}` : ""}`
    case "http":
      return `http ${profile.url}${profile.token ? " (auth)" : ""}`
    case "module":
      return `module ${profile.path}`
    default:
      return (profile as { type: string }).type
  }
}
