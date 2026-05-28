import { ContextBackend, ContextEntry, ContextEntrySummary } from "./types.js"
import { tokenize } from "./lexical.js"

const STALE_VERIFY_MS = 30 * 24 * 60 * 60 * 1000
const ACK_TTL_MS = 7 * 24 * 60 * 60 * 1000

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

export interface MemoryHealth {
  totalEntries: number
  /** Entries with `verifyStatus: "failed"` — the world has changed, the memory hasn't. */
  failedVerifies: MemoryHealthEntry[]
  /** Entries with a `verify:` block that has never been run. */
  neverVerified: MemoryHealthEntry[]
  /** Entries verified successfully but more than 30 days ago. */
  staleVerifies: MemoryHealthEntry[]
  /** Near-duplicate entry pairs at different ids (candidate revise-or-supersede targets). */
  duplicateClusters: DuplicateCluster[]
  /** Total count of issues (sum of the buckets above). Useful for one-line summaries. */
  issueCount: number
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
    return backend.health(options)
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
  const neverVerified: MemoryHealthEntry[] = []
  const staleVerifies: MemoryHealthEntry[] = []

  for (const e of summaries) {
    if (e.verifyStatus === "failed") {
      failedVerifies.push({ ...e, key: `failed:${e.id}` })
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

  return {
    totalEntries: summaries.length,
    failedVerifies,
    neverVerified,
    staleVerifies,
    duplicateClusters,
    issueCount:
      failedVerifies.length +
      neverVerified.length +
      staleVerifies.length +
      duplicateClusters.length,
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
 * left as a convention.
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
  return {
    ...health,
    failedVerifies,
    neverVerified,
    staleVerifies,
    duplicateClusters,
    issueCount:
      failedVerifies.length +
      neverVerified.length +
      staleVerifies.length +
      duplicateClusters.length,
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
 * (e.g. the brief header). Returns empty string when nothing is wrong.
 */
export function renderHealthHeadline(health: MemoryHealth): string {
  const parts: string[] = []
  if (health.failedVerifies.length > 0) {
    parts.push(`${health.failedVerifies.length} failed verifies`)
  }
  if (health.neverVerified.length > 0) {
    parts.push(`${health.neverVerified.length} never checked`)
  }
  if (health.staleVerifies.length > 0) {
    parts.push(`${health.staleVerifies.length} stale verifies`)
  }
  if (health.duplicateClusters.length > 0) {
    parts.push(`${health.duplicateClusters.length} possible duplicates`)
  }
  return parts.join(" · ")
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
    lines.push(`- ⚠ \`${e.id}\` — ${reason}  _(key: \`${e.key}\`)_`)
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
      `- ⇄ possible duplicates: ${cluster.ids.map((id) => `\`${id}\``).join(" / ")}  _(key: \`${cluster.key}\`)_`,
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

/** Returns true when the entry should be hidden from brief content sections (still listed under health). */
export function isProblemEntry(entry: ContextEntry | ContextEntrySummary): boolean {
  return entry.verifyStatus === "failed"
}
