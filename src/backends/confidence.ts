import { Confidence, ContextEntry, ContextEntrySummary } from "./types.js"

const FRESH_VERIFY_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_CONFIRMATION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Coarse trust signal for search results.
 *
 * The contract with agents is:
 *  - `low`    → don't refuse, don't hedge; verify before relying on it
 *  - `medium` → default; use normally
 *  - `high`   → recently verified or corroborated; cite freely
 *
 * Confidence is intentionally never surfaced to end-users as uncertainty
 * — it's an internal hint that tells the agent when to call
 * `confirm_context` before its turn ends.
 *
 * Signals (in priority order):
 *  - verifyStatus=failed                    → low
 *  - verify spec exists but never run       → low (prompts agent to check)
 *  - verifyStatus=ok and verified ≤30d ago  → high
 *  - ≥2 distinct confirmers in last 30d     → high (cross-agent corroboration)
 *  - anything else                          → medium
 */
export function computeConfidence(
  entry: Pick<
    ContextEntry | ContextEntrySummary,
    "verify" | "verifyStatus" | "verifiedAt"
  > & { confirmations?: ContextEntry["confirmations"] },
  now: number = Date.now(),
): Confidence {
  if (entry.verifyStatus === "failed") return "low"
  if (entry.verify && !entry.verifiedAt) {
    return "low"
  }
  if (entry.verifyStatus === "ok" && entry.verifiedAt) {
    const age = now - Date.parse(entry.verifiedAt)
    if (Number.isFinite(age) && age <= FRESH_VERIFY_MS) return "high"
  }
  if (countDistinctRecentConfirmers(entry.confirmations, now) >= 2) return "high"
  return "medium"
}

function countDistinctRecentConfirmers(
  confirmations: ContextEntry["confirmations"],
  now: number,
): number {
  if (!confirmations || confirmations.length === 0) return 0
  const cutoff = now - RECENT_CONFIRMATION_MS
  const distinct = new Set<string>()
  for (const c of confirmations) {
    const t = Date.parse(c.at)
    if (!Number.isFinite(t) || t < cutoff) continue
    // Strip agent version suffix so claude-code/1.2 and claude-code/1.3 count as one confirmer.
    distinct.add(c.by.split("/")[0])
  }
  return distinct.size
}
