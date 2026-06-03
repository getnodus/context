import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
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

export async function saveConfig(config: NodusConfig): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8")
  await rename(tmp, path)
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
