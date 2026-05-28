import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getNodusConfigDir } from "../backends/index.js"
import { packageVersion } from "./version.js"

const PKG_NAME = "@getnodus/context"
const CACHE_FILE = "update-check.json"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 1500

export interface UpdateInfo {
  current: string
  latest: string
  outdated: boolean
  checkedAt: string
}

interface CacheShape {
  checkedAt: string
  latestVersion: string
}

function cachePath(): string {
  return join(getNodusConfigDir(), CACHE_FILE)
}

function isDisabled(): boolean {
  if (process.env.NODUS_DISABLE_UPDATE_CHECK) return true
  // Skip in CI — noisy and offline runners hang on the fetch.
  if (process.env.CI) return true
  const v = packageVersion()
  // Dev builds (no real version) can't meaningfully compare against npm.
  if (!v || v === "0.0.0") return true
  return false
}

/**
 * Compare two semver-ish strings. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * Pre-releases (e.g. "1.2.3-beta.1") sort below the matching release per
 * semver. We intentionally avoid pulling in a full semver dep — the npm
 * `latest` dist-tag won't normally be a prerelease, but we handle it so an
 * unusual local install doesn't trigger a spurious "update" banner.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string) => {
    const [core, pre = ""] = s.replace(/^v/, "").split("-")
    const parts = core.split(".").map((n) => parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return { parts, pre }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) {
    if (A.parts[i] !== B.parts[i]) return A.parts[i] - B.parts[i]
  }
  if (A.pre === B.pre) return 0
  if (A.pre === "") return 1
  if (B.pre === "") return -1
  return A.pre < B.pre ? -1 : 1
}

async function readCache(): Promise<CacheShape | null> {
  try {
    const raw = await readFile(cachePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<CacheShape>
    if (!parsed?.checkedAt || !parsed?.latestVersion) return null
    return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion }
  } catch {
    return null
  }
}

async function writeCache(latest: string): Promise<void> {
  try {
    await mkdir(getNodusConfigDir(), { recursive: true })
    const payload: CacheShape = {
      checkedAt: new Date().toISOString(),
      latestVersion: latest,
    }
    await writeFile(cachePath(), JSON.stringify(payload) + "\n", "utf8")
  } catch {
    // Cache failures are non-fatal; we'll just try again next run.
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // The `/latest` endpoint returns the latest dist-tag's full packument
    // entry as plain JSON — small enough that we don't need the abbreviated
    // metadata header (which `/latest` rejects with 406).
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { version?: unknown }
    return typeof json.version === "string" ? json.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function infoFrom(latest: string, checkedAt: string): UpdateInfo {
  const current = packageVersion()
  return { current, latest, checkedAt, outdated: compareSemver(current, latest) < 0 }
}

function cacheIsFresh(cache: CacheShape): boolean {
  const t = Date.parse(cache.checkedAt)
  return Number.isFinite(t) && Date.now() - t < CACHE_TTL_MS
}

/**
 * Read the cached update info without making any network call. Returns null
 * if disabled, no cache exists, or cache is malformed. Safe to call from
 * hot paths (MCP brief, CLI banner).
 */
export async function readUpdateInfo(): Promise<UpdateInfo | null> {
  if (isDisabled()) return null
  const cache = await readCache()
  if (!cache) return null
  return infoFrom(cache.latestVersion, cache.checkedAt)
}

/**
 * Refresh the cache if stale (>24h) and return the latest info. Falls back
 * to the cached value (if any) when the fetch fails or times out, so a
 * brief network blip never strips the banner. Returns null when update
 * checks are disabled altogether.
 */
export async function refreshUpdateInfo(): Promise<UpdateInfo | null> {
  if (isDisabled()) return null
  const cache = await readCache()
  if (cache && cacheIsFresh(cache)) {
    return infoFrom(cache.latestVersion, cache.checkedAt)
  }
  const latest = await fetchLatest()
  if (!latest) {
    return cache ? infoFrom(cache.latestVersion, cache.checkedAt) : null
  }
  await writeCache(latest)
  return infoFrom(latest, new Date().toISOString())
}

/**
 * The user-facing upgrade instruction. Points at `context update` — which
 * detects the install method (npm/pnpm/yarn) and runs the right command —
 * rather than hard-coding `npm install -g`. Falls through to the manual
 * command only when the user explicitly asks (e.g. in MCP guidance for agents
 * that can't shell out).
 */
export function upgradeCommand(): string {
  return `context update`
}

/** Raw install command for environments where `context update` isn't reachable. */
export function manualUpgradeCommand(): string {
  return `npm install -g ${PKG_NAME}`
}

export function upgradeHint(info: UpdateInfo): string {
  return `update available: ${info.current} → ${info.latest}  ·  run \`${upgradeCommand()}\``
}
