import type { ContextEntry, VerifySpec, VerifyStatus, Confirmation, WriteInput } from "./types.js"
import { runVerify } from "./verify.js"

/**
 * Convert a ContextEntry to a WriteInput, preserving all fields.
 * Use with spread to override specific fields:
 *
 *     backend.write({ ...toWriteInput(entry), author: "new-author" })
 */
export function toWriteInput(entry: ContextEntry): WriteInput {
  return {
    id: entry.id,
    body: entry.body,
    title: entry.title,
    type: entry.type,
    tags: entry.tags,
    supersedes: entry.supersedes,
    expires: entry.expires,
    author: entry.author,
    verify: entry.verify,
    verifiedAt: entry.verifiedAt,
    verifyStatus: entry.verifyStatus,
    verifyMessage: entry.verifyMessage,
    verifyAccepted: entry.verifyAccepted,
    verifyAcceptedAt: entry.verifyAcceptedAt,
    verifyAcceptedReason: entry.verifyAcceptedReason,
    confirmations: entry.confirmations,
  }
}

/**
 * Compare two entries by their writable content (id, body, metadata).
 * Used to detect no-op writes during sync and mirror read-reconciliation.
 */
export function sameEntryContent(a: ContextEntry, b: ContextEntry): boolean {
  return JSON.stringify(toWriteInput(a)) === JSON.stringify(toWriteInput(b))
}

/**
 * Build a WriteInput that merges `from` into `into`. Tags are unioned,
 * `from.id` is recorded in supersedes, and verify fields prefer `into`.
 * Pass an explicit `body` to override the default join (into + --- + from).
 */
export function mergeEntries(
  from: ContextEntry,
  into: ContextEntry,
  opts: { body?: string; author: string },
): WriteInput {
  const body = opts.body ?? `${into.body.trim()}\n\n---\n\n${from.body.trim()}`
  const tags = Array.from(new Set([...(into.tags ?? []), ...(from.tags ?? [])]))
  const supersedes = Array.from(new Set([...(into.supersedes ?? []), from.id]))
  return {
    id: into.id,
    body,
    title: into.title,
    type: into.type,
    tags,
    supersedes,
    expires: into.expires,
    author: opts.author,
    verify: into.verify ?? from.verify,
    verifyStatus: into.verifyStatus ?? from.verifyStatus,
    verifiedAt: into.verifiedAt ?? from.verifiedAt,
    ...(into.verifyMessage !== undefined
      ? { verifyMessage: into.verifyMessage }
      : from.verifyMessage !== undefined
        ? { verifyMessage: from.verifyMessage }
        : {}),
  }
}

/** Outcome of an inline verify run — fields to spread into a WriteInput. */
export interface InlineVerifyOutcome {
  verifyStatus: VerifyStatus | "unknown"
  verifiedAt: string
  verifyMessage?: string
}

/**
 * Run a verify spec inline with a tight timeout budget. Used by
 * write_context (MCP) and PUT /entries/:id (HTTP server) to check
 * referenced resources at write time without blocking the caller.
 */
export async function runInlineVerify(
  spec: VerifySpec,
  opts: { inlineBudgetMs?: number; onError?: (e: unknown) => void } = {},
): Promise<InlineVerifyOutcome> {
  const budgetMs = opts.inlineBudgetMs ?? 3000
  try {
    const result = await runVerify(spec, { inlineBudgetMs: budgetMs })
    return {
      verifyStatus: result.status,
      verifiedAt: new Date().toISOString(),
      ...(result.message !== undefined ? { verifyMessage: result.message } : {}),
    }
  } catch (e) {
    opts.onError?.(e)
    return { verifyStatus: "unknown", verifiedAt: new Date().toISOString() }
  }
}
