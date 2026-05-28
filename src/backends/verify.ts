import { stat } from "node:fs/promises"
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
}

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
      return verifyUrl(spec.target, fetchImpl, timeoutMs)
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
): Promise<VerifyResult> {
  if (!/^https?:\/\//i.test(url)) {
    return { status: "failed", message: `url verify target must be http(s): ${url}` }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: "GET", signal: ctrl.signal, redirect: "follow" })
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
