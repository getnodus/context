import { stat } from "node:fs/promises"
import dns from "node:dns/promises"
import { VerifySpec, VerifyStatus } from "./types.js"

export interface VerifyResult {
  status: VerifyStatus
  /** Short human-readable detail, especially on failure. */
  message?: string
}

export interface VerifyOptions {
  /** Override fetch implementation (testing). */
  fetch?: typeof fetch
  /**
   * Per-check timeout in ms. Defaults to `NODUS_VERIFY_TIMEOUT_MS` (env) or
   * 8000ms. Callers running verify *inline* during a write (where blocking
   * the response matters) should pass a tighter cap explicitly via
   * `inlineBudgetMs` rather than overriding this — that way the env override
   * still applies to background and on-demand verifies, which is what most
   * users actually want.
   */
  timeoutMs?: number
  /**
   * Cap timeout to at most this many ms (used by inline verify-on-write to
   * keep the write fast even when env sets a generous global timeout).
   * Defaults to ignoring the cap.
   */
  inlineBudgetMs?: number
  /** Override DNS lookup (testing). */
  lookup?: (hostname: string) => Promise<{ address: string }>
}

const MAX_REDIRECTS = 5

/**
 * Resolve the verify timeout: explicit option > env > default.
 * Exposed so callers can also use it (e.g. for AbortController setup that
 * mirrors the verify call).
 */
export function defaultVerifyTimeoutMs(): number {
  const env = process.env.NODUS_VERIFY_TIMEOUT_MS
  if (env) {
    const n = parseInt(env, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 8000
}

/**
 * Run a single VerifySpec and report whether the referenced thing still
 * looks healthy. Pure function over the spec — no side effects on the
 * entry; the caller is responsible for persisting the result.
 *
 * Failure modes are intentionally specific so the message is useful:
 *  - network unreachable        → status=unknown (don't penalize on transient failures)
 *  - 4xx (other than 401/403)   → status=failed
 *  - 5xx                        → status=unknown
 *  - GitHub repo archived       → status=failed (the key archived-repo case)
 *  - filesystem path missing    → status=failed
 */
export async function runVerify(
  spec: VerifySpec,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const fetchImpl = options.fetch ?? fetch
  let timeoutMs = options.timeoutMs ?? defaultVerifyTimeoutMs()
  if (options.inlineBudgetMs && timeoutMs > options.inlineBudgetMs) {
    timeoutMs = options.inlineBudgetMs
  }

  switch (spec.kind) {
    case "url":
      return verifyUrl(spec.target, fetchImpl, timeoutMs, options.lookup)
    case "repo":
      return verifyRepo(spec.target, fetchImpl, timeoutMs)
    case "path":
      return verifyPath(spec.target)
    default:
      return { status: "unknown", message: `unknown verify kind "${(spec as VerifySpec).kind}"` }
  }
}

async function verifyUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  lookup?: VerifyOptions["lookup"],
): Promise<VerifyResult> {
  const preflight = await assertPublicUrl(url, lookup)
  if (preflight) return preflight

  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(current, {
        method: "GET",
        signal: ctrl.signal,
        redirect: "manual",
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        await res.body?.cancel?.()
        if (!location) {
          return { status: "failed", message: `redirect ${res.status} missing Location header` }
        }
        current = new URL(location, current).href
        const redirectCheck = await assertPublicUrl(current, lookup)
        if (redirectCheck) return redirectCheck
        continue
      }

      if (res.status >= 200 && res.status < 300) return { status: "ok" }
      if (res.status >= 500) return { status: "unknown", message: `server returned ${res.status}` }
      return { status: "failed", message: `HTTP ${res.status}` }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        return { status: "unknown", message: `timed out after ${timeoutMs}ms` }
      }
      return { status: "unknown", message: e?.message ?? String(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  return { status: "failed", message: `too many redirects (max ${MAX_REDIRECTS})` }
}

/**
 * Returns a VerifyResult when the URL must be blocked, or null when safe to fetch.
 */
async function assertPublicUrl(
  url: string,
  lookup?: VerifyOptions["lookup"],
): Promise<VerifyResult | null> {
  if (!/^https?:\/\//i.test(url)) {
    return { status: "failed", message: `url verify target must be http(s): ${url}` }
  }
  if (isPrivateUrl(url)) {
    return { status: "failed", message: "url verify target must not point to a private/internal address" }
  }

  const hostname = urlHostname(url)
  if (!isIpLiteral(hostname)) {
    try {
      const resolve = lookup ?? ((h: string) => dns.lookup(h, { verbatim: true }))
      const { address } = await resolve(hostname)
      if (isPrivateIp(address)) {
        return {
          status: "failed",
          message: "url verify target resolves to a private/internal address",
        }
      }
    } catch (e: any) {
      return {
        status: "unknown",
        message: `url verify target DNS lookup failed: ${e?.message ?? String(e)}`,
      }
    }
  }

  return null
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "")
  } catch {
    return ""
  }
}

function isIpLiteral(hostname: string): boolean {
  if (!hostname) return false
  if (hostname.includes(":")) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Block requests to private/internal network addresses to prevent SSRF.
 * Rejects loopback, link-local, RFC-1918 private ranges, CGNAT, and cloud
 * metadata endpoints. Hostname literals and resolved IPs share the same rules.
 */
export function isPrivateUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "")
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true
  return isPrivateIp(hostname)
}

/** True when `host` is a loopback, RFC-1918, link-local, CGNAT, or ULA address. */
export function isPrivateIp(host: string): boolean {
  const hostname = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (hostname === "localhost") return true

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const parts = ipv4Match.slice(1).map(Number)
    if (parts.some((n) => n > 255)) return true
    const [a, b] = parts
    if (a === 10) return true // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 127) return true // 127.0.0.0/8
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local + metadata
    if (a === 0) return true // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    return false
  }

  if (hostname.includes(":")) {
    if (hostname === "::1") return true
    if (hostname.startsWith("fe80:")) return true // link-local
    if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true // ULA fc00::/7
  }

  return false
}

async function verifyRepo(
  target: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<VerifyResult> {
  const slug = parseRepoSlug(target)
  if (!slug) {
    return { status: "failed", message: `repo verify target must be owner/name (or a github.com URL): ${target}` }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${slug}`, {
      method: "GET",
      headers: { accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    })
    if (res.status === 404) return { status: "failed", message: `repo not found: ${slug}` }
    if (res.status === 403) {
      // Rate limited (no auth) — treat as transient.
      return { status: "unknown", message: "github API rate limited" }
    }
    if (res.status >= 500) return { status: "unknown", message: `github API returned ${res.status}` }
    if (!res.ok) return { status: "failed", message: `github API returned ${res.status}` }
    const data = (await res.json().catch(() => null)) as { archived?: boolean } | null
    if (data?.archived) return { status: "failed", message: `repo is archived: ${slug}` }
    return { status: "ok" }
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { status: "unknown", message: `timed out after ${timeoutMs}ms` }
    }
    return { status: "unknown", message: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
  }
}

async function verifyPath(target: string): Promise<VerifyResult> {
  try {
    await stat(expandHome(target))
    return { status: "ok" }
  } catch (e: any) {
    if (e?.code === "ENOENT") return { status: "failed", message: `path not found: ${target}` }
    return { status: "unknown", message: e?.message ?? String(e) }
  }
}

function parseRepoSlug(target: string): string | null {
  const trimmed = target.trim()
  // accept "owner/name", "github.com/owner/name", "https://github.com/owner/name(.git)?"
  const ghMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+?)(?:\.git)?(?:[\/#?].*)?$/i)
  if (ghMatch) return `${ghMatch[1]}/${ghMatch[2]}`
  const plain = trimmed.match(/^([^\/\s]+)\/([^\/\s]+)$/)
  if (plain) return `${plain[1]}/${plain[2]}`
  return null
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME ?? ""
    return p === "~" ? home : `${home}/${p.slice(2)}`
  }
  return p
}
