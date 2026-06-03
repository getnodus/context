import {
  ContextBackend,
  ContextEntrySummary,
  BackendDescription,
} from "../backends/index.js"
import {
  computeMemoryHealth,
  entryHealthMarker,
  filterAcked,
  filterForBrief,
  renderHealthBullets,
  renderHealthHeadline,
} from "../backends/health.js"
import { loadAcks } from "../health/acks.js"
import { readUpdateInfo, manualUpgradeCommand } from "../cli/update-check.js"
import { selectWorkspaceEntries } from "./workspace.js"

const BRIEF_SECTION_CAP = 8

export interface BriefOptions {
  /**
   * Normalized slugs describing the agent's current workspace (repo/dir names),
   * derived from MCP roots or cwd. When non-empty, the brief adds a "This
   * workspace" section surfacing entries whose id segments or tags match a hint.
   */
  hints?: string[]
}

/** One brief bullet for an entry: id + health marker + tags + author + preview. */
function renderEntryBullet(e: ContextEntrySummary): string[] {
  const marker = entryHealthMarker(e)
  const markerPrefix = marker ? `${marker} ` : ""
  const tags = e.tags.length > 0 ? `  _[${e.tags.join(", ")}]_` : ""
  const author = e.author ? `  _by ${e.author}_` : ""
  const out = [`- ${markerPrefix}**${e.id}**${tags}${author}`]
  if (e.preview) out.push(`  ${e.preview}`)
  return out
}

/**
 * A capped, recency-ordered section of entry bullets, with an "…and N more"
 * tail when the section overflows the cap. `subtitle`, if given, renders as an
 * italic line under the heading.
 */
function renderSection(
  heading: string,
  entries: ContextEntrySummary[],
  subtitle?: string,
): string[] {
  const sorted = entries.slice().sort((a, b) => b.updated.localeCompare(a.updated))
  const shown = sorted.slice(0, BRIEF_SECTION_CAP)
  const lines = [`## ${heading}`, ""]
  if (subtitle) lines.push(`_${subtitle}_`, "")
  for (const e of shown) lines.push(...renderEntryBullet(e))
  if (sorted.length > shown.length) {
    lines.push(
      `- _…and ${sorted.length - shown.length} more — query with \`list_context\` if you need them_`,
    )
  }
  lines.push("")
  return lines
}

export async function renderBrief(
  backend: ContextBackend,
  desc: BackendDescription,
  opts: BriefOptions = {},
): Promise<string> {
  const [rules, preferences, identity, all, healthRaw, acks, update] = await Promise.all([
    backend.list({ type: "rule" }),
    backend.list({ type: "preference" }),
    backend.list({ prefix: "user/" }),
    backend.list(),
    computeMemoryHealth(backend),
    loadAcks(backend),
    readUpdateInfo(),
  ])
  const health = filterForBrief(filterAcked(healthRaw, acks))

  const caps: string[] = []
  if (desc.capabilities.history) caps.push("history")
  if (desc.capabilities.semanticSearch) caps.push("semantic search")
  const capStr = caps.length > 0 ? ` · ${caps.join(", ")}` : ""

  const lines: string[] = [
    "# User context brief",
    "",
    `_Backend: **${desc.type}** — ${desc.label} · ${all.length} entries${capStr}_`,
  ]

  // Update notice — agents see this at session start. Phrase it as a fact
  // for the agent to relay, not as an action the agent should take; the
  // user is the one who runs `npm install -g`. Surfaced once per session;
  // no ack mechanism because the cache itself bounds noise to ~daily.
  if (update?.outdated) {
    lines.push(
      "",
      `> **Heads-up for the user:** \`@getnodus/context\` is out of date on this machine ` +
        `(installed ${update.current}, latest ${update.latest}). Tell the user once and ` +
        `suggest they run \`context update\` (or \`${manualUpgradeCommand()}\` if they ` +
        `don't have the CLI on PATH) when convenient. Don't refuse to use the tool — ` +
        `it still works.`,
    )
  }

  // Memory health surface — the only place this information is shown
  // automatically. Agents see it before they touch the store.
  const healthBullets = renderHealthBullets(health)
  if (healthBullets.length > 0) {
    const headline = renderHealthHeadline(health)
    lines.push(
      "",
      `## Memory health — ${headline}`,
      "",
      ...healthBullets,
      "",
      "_Mention these to the user once, briefly, and offer to clean up. After mentioning, call " +
        "`acknowledge_health` with the keys above so they don't reappear in the next brief._",
    )
  }
  lines.push("")

  const sections: Array<[string, ContextEntrySummary[]]> = [
    ["Rules (must follow)", rules],
    ["Preferences (respect when possible)", preferences],
    ["Identity", identity.filter((e) => e.type !== "rule" && e.type !== "preference")],
  ]

  let any = false
  for (const [heading, entries] of sections) {
    // Failed-verify entries are SHOWN here with a ⚠ marker (not hidden) —
    // rules and preferences are load-bearing; a failed verify on a
    // referenced URL doesn't mean the rule itself no longer applies.
    // Memory health (above) flags the verify failure separately.
    if (entries.length === 0) continue
    any = true
    lines.push(...renderSection(heading, entries))
  }

  // Workspace-relevant context. Best-effort: when the client exposed a
  // workspace (MCP roots / cwd), surface entries whose id segments or tags
  // match it so the agent starts the session already knowing about *this*
  // repo, not just always-on rules. Excludes ids already shown above to
  // avoid repetition. Omitted entirely when there are no hints or no
  // matches — a client without roots sees exactly the brief it saw before.
  const shownIds = new Set<string>([
    ...rules.map((e) => e.id),
    ...preferences.map((e) => e.id),
    ...identity.map((e) => e.id),
  ])
  const workspace = selectWorkspaceEntries(all, opts.hints ?? [], shownIds)
  if (workspace.length > 0) {
    any = true
    const subtitle = `Matching ${(opts.hints ?? []).map((h) => `\`${h}\``).join(", ")}`
    lines.push(...renderSection("This workspace", workspace, subtitle))
  }

  if (!any && healthBullets.length === 0) {
    lines.push(
      "_No durable user context recorded yet. As you learn things about the user that should " +
        "persist across sessions, call `write_context` with an appropriate `type`._",
    )
  } else {
    lines.push(
      "---",
      "_Use `list_context`, `search_context`, or read the `nodus-context://entry/{id}` resources for full bodies._",
    )
  }

  return lines.join("\n")
}
