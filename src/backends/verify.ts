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
  /** Per-check timeout in ms. Default 8000. */
  timeoutMs?: number
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
  const timeoutMs = options.timeoutMs ?? 8000

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
