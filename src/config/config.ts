import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { getNodusConfigDir, Profile } from "../backends/index.js"
import type { AgentDefinition } from "../cli/agents/types.js"

export interface NodusConfig {
  /** Name of the currently-active profile. Must be a key in profiles. */
  activeProfile: string
  profiles: Record<string, Profile>
  /**
   * User-declared MCP agents. Loaded in addition to the built-in registry.
   * Use this to teach `context` about an MCP client we don't ship
   * built-in support for, without forking. An entry whose id matches a
   * built-in shadows the built-in (useful for overriding a config path).
   */
  customAgents?: AgentDefinition[]
}

const DEFAULT_PROFILE_NAME = "default"

export function configPath(): string {
  return join(getNodusConfigDir(), "config.json")
}

export function defaultConfig(): NodusConfig {
  return {
    activeProfile: DEFAULT_PROFILE_NAME,
    profiles: {
      [DEFAULT_PROFILE_NAME]: { type: "local" },
    },
  }
}

export async function loadConfig(): Promise<NodusConfig> {
  const path = configPath()
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e: any) {
    if (e.code === "ENOENT") return defaultConfig()
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`could not parse ${path}: ${e.message}`)
  }
  return normalizeConfig(parsed)
}

/** Restrictive mode for config.json — bearer tokens live here. */
export const CONFIG_FILE_MODE = 0o600

export async function saveConfig(config: NodusConfig): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: CONFIG_FILE_MODE })
  await rename(tmp, path)
  try {
    await chmod(path, CONFIG_FILE_MODE)
  } catch {
    // chmod is best-effort (e.g. some Windows FS layouts); write mode still applies on create.
  }
}

/**
 * Return a copy of the config safe for JSON logging (CLI --json, agent transcripts).
 * Bearer tokens are replaced with a redaction marker; `authed: true` is preserved on
 * http profiles so callers still know auth is configured.
 */
export function redactConfig(config: NodusConfig): NodusConfig {
  const profiles: Record<string, Profile> = {}
  for (const [name, profile] of Object.entries(config.profiles)) {
    profiles[name] = redactProfile(profile)
  }
  return {
    activeProfile: config.activeProfile,
    profiles,
    ...(config.customAgents ? { customAgents: config.customAgents } : {}),
  }
}

function redactProfile(profile: Profile): Profile {
  switch (profile.type) {
    case "http": {
      if (!profile.token && !profile.headers) return profile
      return {
        ...profile,
        ...(profile.token ? { token: "<redacted>" } : {}),
        ...(profile.headers ? { headers: redactHeaders(profile.headers) } : {}),
      }
    }
    case "mirror":
      return {
        type: "mirror",
        primary: redactProfile(profile.primary),
        secondary: redactProfile(profile.secondary) as Extract<Profile, { type: "http" }>,
      }
    default:
      return profile
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((name) => [name, "<redacted>"]))
}

export async function getActiveProfile(): Promise<{ name: string; profile: Profile }> {
  const config = await loadConfig()
  const profile = config.profiles[config.activeProfile]
  if (!profile) {
    throw new Error(
      `active profile "${config.activeProfile}" is not defined in ${configPath()}`,
    )
  }
  return { name: config.activeProfile, profile }
}

export function normalizeConfig(value: unknown): NodusConfig {
  if (!value || typeof value !== "object") {
    throw new Error("config must be a JSON object")
  }
  const v = value as Record<string, unknown>
  const profiles = (v.profiles ?? {}) as Record<string, Profile>
  if (typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("config.profiles must be an object")
  }
  let activeProfile = typeof v.activeProfile === "string" ? v.activeProfile : DEFAULT_PROFILE_NAME

  // Bootstrap: empty profiles → add default local
  if (Object.keys(profiles).length === 0) {
    profiles[DEFAULT_PROFILE_NAME] = { type: "local" }
    activeProfile = DEFAULT_PROFILE_NAME
  }

  if (!profiles[activeProfile]) {
    // Pick the first profile if active is missing
    const first = Object.keys(profiles)[0]
    activeProfile = first
  }

  const customAgents = Array.isArray(v.customAgents)
    ? (v.customAgents as AgentDefinition[])
    : undefined

  return {
    activeProfile,
    profiles,
    ...(customAgents ? { customAgents } : {}),
  }
}
