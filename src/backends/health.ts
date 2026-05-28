import { ContextBackend, ContextEntry, ContextEntrySummary } from "./types.js"
import { tokenize } from "./lexical.js"

const STALE_VERIFY_MS = 30 * 24 * 60 * 60 * 1000
const ACK_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * "Fresh store" grace window. On a brand new install (every entry created
 * within the last 24h), `neverVerified` is suppressed from the brief —
 * the user just added them, of course they haven't been checked yet.
 * `doctor --memory` still shows the full picture; this is only about not
 * nagging during onboarding.
 */
const FRESH_STORE_GRACE_MS = 24 * 60 * 60 * 1000

export interface DuplicateCluster {
  /** Two or more entry ids that look like duplicates of each other. */
  ids: string[]
  /** Lexical overlap score (rough). */
  overlap: number
  /** Stable key for acknowledgment tracking. */
  key: string
}

export interface MemoryHealthEntry extends ContextEntrySummary {
  /** Stable key for acknowledgment tracking. */
  key: string
}

export interface AcceptedHealthEntry extends MemoryHealthEntry {
  verifyAcceptedAt?: string
  verifyAcceptedReason?: string
}

export interface MemoryHealth {
  totalEntries: number
  /** Entries with `verifyStatus: "failed"` and NOT user-accepted — the world has changed, the memory hasn't. */
  failedVerifies: MemoryHealthEntry[]
  /** Entries the user has explicitly accepted as known-failing. Informational only — not surfaced to agents as a problem. */
  acceptedVerifies: AcceptedHealthEntry[]
  /** Entries with a `verify:` block that has never been run. */
  neverVerified: MemoryHealthEntry[]
  /** Entries verified successfully but more than 30 days ago. */
  staleVerifies: MemoryHealthEntry[]
  /** Near-duplicate entry pairs at different ids (candidate revise-or-supersede targets). */
  duplicateClusters: DuplicateCluster[]
  /** Total count of issues (failedVerifies + neverVerified + staleVerifies + duplicateClusters). Excludes accepted. */
  issueCount: number
  /**
   * Counts split by urgency tier:
   *  - `urgent`        — needs eyes: failed verifies (not accepted)
   *  - `informational` — routine cleanup: never-checked, stale, possible duplicates
   */
  urgency: { urgent: number; informational: number }
  /**
   * True if every entry was created within the last 24h (fresh install).
   * The brief uses this to suppress never-checked nags during onboarding.
   */
  freshStore: boolean
}

export interface HealthOptions {
  /** Skip the duplicate scan above this entry count (O(n²); default skip when >200). */
  duplicateScanLimit?: number
  /** Override "now" for testing. */
  now?: number
}

/** key → ISO timestamp of acknowledgment. */
export type HealthAckMap = Record<string, string>

/**
 * Read-only audit. Surfaces what's been silently accumulating so it can be
 * shown in the brief or the doctor command. Never mutates entries.
 *
 * When the backend exposes a `health()` method (e.g. HttpBackend with a
 * /health endpoint), it delegates to that — avoids transferring full entry
 * lists across the network just to compute a summary.
 */
export async function computeMemoryHealth(
  backend: ContextBackend,
  options: HealthOptions = {},
): Promise<MemoryHealth> {
  if (backend.health) {
    return normalizeHealth(await backend.health(options))
  }
  return computeMemoryHealthDirect(backend, options)
}

/**
 * Direct (no-delegation) computation. Backends that *implement* `health()`
 * call this to do the actual work without recursing.
 */
export async function computeMemoryHealthDirect(
  backend: ContextBackend,
  options: HealthOptions = {},
): Promise<MemoryHealth> {
  const now = options.now ?? Date.now()
  const dupLimit = options.duplicateScanLimit ?? 200

  const summaries = await backend.list({ includeExpired: false, limit: 500 })

  const failedVerifies: MemoryHealthEntry[] = []
  const acceptedVerifies: AcceptedHealthEntry[] = []
  const neverVerified: MemoryHealthEntry[] = []
  const staleVerifies: MemoryHealthEntry[] = []

  for (const e of summaries) {
    if (e.verifyStatus === "failed") {
      if (e.verifyAccepted) {
        acceptedVerifies.push({
          ...e,
          key: `accepted:${e.id}`,
          verifyAcceptedAt: e.verifyAcceptedAt,
          verifyAcceptedReason: e.verifyAcceptedReason,
        })
      } else {
        failedVerifies.push({ ...e, key: `failed:${e.id}` })
      }
      continue
    }
    if (e.verify && !e.verifiedAt) {
      neverVerified.push({ ...e, key: `never:${e.id}` })
      continue
    }
    if (e.verifyStatus === "ok" && e.verifiedAt) {
      const age = now - Date.parse(e.verifiedAt)
      if (Number.isFinite(age) && age > STALE_VERIFY_MS) {
        staleVerifies.push({ ...e, key: `stale:${e.id}` })
      }
    }
  }

  let duplicateClusters: DuplicateCluster[] = []
  if (summaries.length > 0 && summaries.length <= dupLimit) {
    duplicateClusters = await findDuplicateClusters(backend, summaries)
  }

  const freshStore =
    summaries.length > 0 &&
    summaries.every((e) => now - Date.parse(e.created) <= FRESH_STORE_GRACE_MS)

  const urgent = failedVerifies.length
  const informational =
    neverVerified.length + staleVerifies.length + duplicateClusters.length

  return {
    totalEntries: summaries.length,
    failedVerifies,
    acceptedVerifies,
    neverVerified,
    staleVerifies,
    duplicateClusters,
    issueCount: urgent + informational,
    urgency: { urgent, informational },
    freshStore,
  }
}

/**
 * Backfill defaults for health payloads coming from older backends (e.g.
 * HTTP server before urgency/freshStore was added). Keeps consumers safe
 * without making every server upgrade in lockstep.
 */
function normalizeHealth(raw: any): MemoryHealth {
  const failedVerifies: MemoryHealthEntry[] = Array.isArray(raw?.failedVerifies) ? raw.failedVerifies : []
  const acceptedVerifies: AcceptedHealthEntry[] = Array.isArray(raw?.acceptedVerifies) ? raw.acceptedVerifies : []
  const neverVerified: MemoryHealthEntry[] = Array.isArray(raw?.neverVerified) ? raw.neverVerified : []
  const staleVerifies: MemoryHealthEntry[] = Array.isArray(raw?.staleVerifies) ? raw.staleVerifies : []
  const duplicateClusters: DuplicateCluster[] = Array.isArray(raw?.duplicateClusters) ? raw.duplicateClusters : []
  const urgent = failedVerifies.length
  const informational = neverVerified.length + staleVerifies.length + duplicateClusters.length
  return {
    totalEntries: typeof raw?.totalEntries === "number" ? raw.totalEntries : 0,
    failedVerifies,
    acceptedVerifies,
    neverVerified,
    staleVerifies,
    duplicateClusters,
    issueCount: typeof raw?.issueCount === "number" ? raw.issueCount : urgent + informational,
    urgency: raw?.urgency ?? { urgent, informational },
    freshStore: raw?.freshStore === true,
  }
}

/** Returns true if `key` was acknowledged within the last 7 days. */
export function isAcked(acks: HealthAckMap | undefined, key: string, now = Date.now()): boolean {
  if (!acks) return false
  const at = acks[key]
  if (!at) return false
  const t = Date.parse(at)
  return Number.isFinite(t) && now - t <= ACK_TTL_MS
}

/**
 * Returns a copy of `health` with acknowledged-recently issues removed. Used
 * by the brief renderer so "mention once per session" is enforced rather than
 * left as a convention. Accepted-verifies are never filtered (they're already
 * a user-driven suppression, not a transient ack).
 */
export function filterAcked(
  health: MemoryHealth,
  acks: HealthAckMap | undefined,
  now = Date.now(),
): MemoryHealth {
  if (!acks) return health
  const keep = <T extends { key: string }>(items: T[]): T[] =>
    items.filter((i) => !isAcked(acks, i.key, now))
  const failedVerifies = keep(health.failedVerifies)
  const neverVerified = keep(health.neverVerified)
  const staleVerifies = keep(health.staleVerifies)
  const duplicateClusters = keep(health.duplicateClusters)
  const urgent = failedVerifies.length
  const informational = neverVerified.length + staleVerifies.length + duplicateClusters.length
  return {
    ...health,
    failedVerifies,
    neverVerified,
    staleVerifies,
    duplicateClusters,
    issueCount: urgent + informational,
    urgency: { urgent, informational },
  }
}

/**
 * Trim health down to what should actually appear in the brief — applies
 * the "fresh store" grace by hiding never-checked on a brand new install.
 * The full picture stays available via `doctor --memory`; this is only
 * about not nagging during onboarding.
 */
export function filterForBrief(health: MemoryHealth): MemoryHealth {
  if (!health.freshStore) return health
  const neverVerified: MemoryHealthEntry[] = []
  const informational =
    neverVerified.length +
    health.staleVerifies.length +
    health.duplicateClusters.length
  return {
    ...health,
    neverVerified,
    issueCount: health.failedVerifies.length + informational,
    urgency: { urgent: health.failedVerifies.length, informational },
  }
}

/**
 * Lightweight pairwise overlap. Reads each entry once, tokenizes title + tags
 * (cheap, doesn't need body), and pairs entries with a Jaccard ≥ threshold.
 * Skips pairs where one id is a prefix of the other (intentional grouping).
 */
async function findDuplicateClusters(
  backend: ContextBackend,
  summaries: ContextEntrySummary[],
): Promise<DuplicateCluster[]> {
  // For better precision, read a tokenized "fingerprint" per entry using
  // the preview already in the summary (160 chars of body) plus title + tags.
  // We avoid reading every full body — that would make the audit slow.
  const fingerprints = summaries.map((e) => ({
    id: e.id,
    tokens: new Set([
      ...tokenize(e.title),
      ...tokenize(e.tags.join(" ")),
      ...tokenize(e.preview),
    ]),
  }))

  const clusters: DuplicateCluster[] = []
  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const a = fingerprints[i]
      const b = fingerprints[j]
      if (a.id.startsWith(b.id + "/") || b.id.startsWith(a.id + "/")) continue
      const overlap = jaccard(a.tokens, b.tokens)
      if (overlap >= 0.6 && Math.min(a.tokens.size, b.tokens.size) >= 4) {
        const sorted = [a.id, b.id].sort()
        clusters.push({
          ids: sorted,
          overlap,
          key: `dup:${sorted.join("|")}`,
        })
      }
    }
  }
  clusters.sort((x, y) => y.overlap - x.overlap)
  return clusters.slice(0, 8)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const tok of a) if (b.has(tok)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Compact one-line summary for surfaces that can only show a single line
 * (e.g. the brief header). Splits urgent vs informational so consumers can
 * style or color them differently. Returns empty string when nothing's wrong.
 */
export function renderHealthHeadline(health: MemoryHealth): string {
  const urgent: string[] = []
  const info: string[] = []
  if (health.failedVerifies.length > 0) urgent.push(`${health.failedVerifies.length} failed`)
  if (health.neverVerified.length > 0) info.push(`${health.neverVerified.length} never checked`)
  if (health.staleVerifies.length > 0) info.push(`${health.staleVerifies.length} stale`)
  if (health.duplicateClusters.length > 0) info.push(`${health.duplicateClusters.length} possible duplicates`)
  if (urgent.length === 0 && info.length === 0) return ""
  if (urgent.length === 0) return info.join(" · ")
  if (info.length === 0) return urgent.join(" · ")
  return `${urgent.join(" · ")}  ·  (${info.join(", ")})`
}

/**
 * `failedVerifies` get full attention; the rest are paged to keep the
 * brief from sprawling. Returns markdown bullets, suitable for embedding
 * under a `## Memory health` heading. Each bullet includes the issue's
 * `key` so the agent can pass it to `acknowledge_health` after mentioning.
 */
export function renderHealthBullets(health: MemoryHealth, maxEach = 3): string[] {
  const lines: string[] = []
  for (const e of health.failedVerifies.slice(0, maxEach)) {
    const reason = e.verifyMessage ?? "verification failed"
    lines.push(`- ⚠ \`${e.id}\` — ${reason}  _(key: \`${e.key}\`; \`context accept ${e.id}\` to silence if expected)_`)
  }
  if (health.failedVerifies.length > maxEach) {
    lines.push(`- _…and ${health.failedVerifies.length - maxEach} more failed verifies_`)
  }
  for (const e of health.neverVerified.slice(0, maxEach)) {
    lines.push(`- ◐ \`${e.id}\` — has a verify spec, never checked  _(key: \`${e.key}\`)_`)
  }
  if (health.neverVerified.length > maxEach) {
    lines.push(`- _…and ${health.neverVerified.length - maxEach} more never-checked_`)
  }
  for (const cluster of health.duplicateClusters.slice(0, maxEach)) {
    lines.push(
      `- ⇄ possible duplicates: ${cluster.ids.map((id) => `\`${id}\``).join(" / ")}  _(key: \`${cluster.key}\`; \`context merge ${cluster.ids[0]} ${cluster.ids[1]}\` to combine)_`,
    )
  }
  if (health.duplicateClusters.length > maxEach) {
    lines.push(`- _…and ${health.duplicateClusters.length - maxEach} more possible duplicates_`)
  }
  // Stale verifies are softer signal — only list when there's nothing more urgent.
  if (lines.length === 0 && health.staleVerifies.length > 0) {
    for (const e of health.staleVerifies.slice(0, maxEach)) {
      lines.push(
        `- ◷ \`${e.id}\` — last verified ${e.verifiedAt?.slice(0, 10)}  _(key: \`${e.key}\`)_`,
      )
    }
  }
  return lines
}

/**
 * Marker for entries that should be tagged in brief content sections but
 * NOT hidden. Failed verifies on rules/preferences are load-bearing — the
 * rule is still active even if a referenced URL moved.
 */
export function entryHealthMarker(entry: ContextEntry | ContextEntrySummary): string | null {
  if (entry.verifyStatus === "failed" && !entry.verifyAccepted) return "⚠"
  if (entry.verify && !entry.verifiedAt) return "◐"
  return null
}
