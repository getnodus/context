#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  ContextNotFoundError,
  InvalidIdError,
  BodyTooLargeError,
  NotSupportedError,
  BackendError,
  createBackend,
  ContextBackend,
  ContextEntry,
  ContextEntrySummary,
  Confirmation,
  VerifySpec,
} from "../backends/index.js"
import { runVerify } from "../backends/verify.js"
import {
  computeMemoryHealth,
  entryHealthMarker,
  filterAcked,
  filterForBrief,
  renderHealthBullets,
  renderHealthHeadline,
} from "../backends/health.js"
import { loadAcks, recordAcks } from "../health/acks.js"
import { getActiveProfile } from "../config/index.js"
import { packageVersion } from "../cli/version.js"
import { readUpdateInfo, refreshUpdateInfo, manualUpgradeCommand } from "../cli/update-check.js"

const ID_FIELD = z
  .string()
  .min(1)
  .describe(
    'Path-style identifier for the context entry, e.g. "user/identity" or "projects/nodus". ' +
      "Use lowercase, alphanumeric segments separated by /.",
  )

export async function run() {
  const { profile } = await getActiveProfile()
  const backend = await createBackend(profile, { backgroundVerify: true })
  await backend.init?.()
  const desc = backend.describe()

  // Refresh the npm-update cache in the background. The brief reads from the
  // cache only — first session after install may not yet show the notice, but
  // every subsequent session will. Fire-and-forget; failures are silent.
  refreshUpdateInfo().catch(() => {})

  const envAuthor = process.env.NODUS_CONTEXT_AGENT

  const server = new McpServer(
    {
      name: "nodus-context",
      title: "Nodus Context",
      version: packageVersion(),
      icons: loadIcons(),
    },
    {
      instructions:
        `Persistent personal context layer for this user. Backend: ${desc.label}.\n\n` +
        "AT SESSION START, read the resource `nodus-context://brief` for always-on facts " +
        "(rules, preferences, identity) — these shape how the user expects you to behave.\n\n" +
        "Use the tools to recall and save what you learn across sessions:\n" +
        "  - list_context / search_context — pull relevant entries before answering\n" +
        "  - read_context — fetch a specific entry by id\n" +
        "  - write_context — save durable facts (use the `type` field: rule, preference, " +
        "fact, decision, gotcha, project-state, reference)\n" +
        "  - confirm_context — call this before ending your turn on entries you actually cited; " +
        "it re-verifies them and records a confirmation\n" +
        "  - accept_context — user has said a failing verify is expected; mark it accepted so " +
        "it stops being surfaced as a problem\n" +
        "  - merge_context — combine two entries when search/duplicates flag overlap\n" +
        "  - acknowledge_health — call this after mentioning brief health issues so they don't " +
        "reappear next session\n" +
        "  - list_tags — see existing tags before inventing new ones\n\n" +
        "Entry id convention: path-style, e.g. `user/identity`, `preferences/communication`, " +
        "`projects/<name>`, `decisions/<date>-<topic>`. When superseding a prior entry, " +
        "pass its id in the `supersedes` field on write so the link is recorded.\n\n" +
        "DECIDING WHAT TO SAVE — the embarrassment test:\n" +
        "  - Before calling `write_context`, ask: would I be embarrassed to make this same " +
        "mistake — or ask this same question — again next session? If yes, save. If no, skip.\n" +
        "  - Pass: capability false-negatives the user corrected (you said 'I can't do X' → user " +
        "said 'yes you can, here's how'), preference reveals, 'we tried that and it broke', " +
        "non-obvious constraints, anything the user shouldn't have to teach you twice.\n" +
        "  - Skip: code structure, file paths, recent commits, current task state — all " +
        "re-derivable from the repo, `git log`, or the live conversation.\n\n" +
        "ANNOUNCING SAVES:\n" +
        "  - When you create a NEW entry, tell the user in one short line: \"I added that to " +
        "memory so we won't forget.\" Use 'we' — memory is the shared scratchpad, not your " +
        "private notebook. The announcement lets the user object in the moment before the " +
        "entry calcifies.\n" +
        "  - When you EDIT an existing entry (same id, or via `supersedes`), or call " +
        "`confirm_context`, stay silent. Narrating every touch becomes chatter.\n\n" +
        "MEMORY HYGIENE (important):\n" +
        "  - Use entries with confidence. Never hedge to the user that memory might be stale.\n" +
        "  - `search_context` hits carry a `confidence` field (low/medium/high). Treat `low` as " +
        "a signal to verify the entry before relying on it — not as a reason to refuse it.\n" +
        "  - Before ending your turn, call `confirm_context` on entries you actually used. " +
        "It runs any declared `verify` block and records a confirmation timestamp.\n" +
        "  - If verification reveals the entry is wrong, OR if the user corrects a false " +
        "claim of yours (especially the pattern 'I can't / don't have / not possible' → " +
        "'yes you can, here's how'), search the store first with `search_context`. If a " +
        "related entry exists, REVISE IT via `write_context` to the same id. If nothing " +
        "related exists, write a fresh entry. Do NOT create a duplicate next to the old one " +
        "— that's how stores rot.\n" +
        "  - If the user confirms a failing verify is intentional (e.g. 'yes that repo was " +
        "archived on purpose'), call `accept_context` so it stops being flagged as a problem.\n" +
        "  - `write_context` returns `relatedExisting[]` when the new content overlaps with " +
        "entries at other ids. Each item has a `relation`: `same-subject` (likely a duplicate — " +
        "strongly prefer overwriting or `supersedes`-linking) or `similar` (sibling concept).\n" +
        "  - `write_context` runs the entry's `verify` block immediately; if `verifyWarning` is " +
        "in the response, the thing you just referenced may not exist — surface that to the user " +
        "and offer to revise.\n" +
        "  - The brief may include a `## Memory health` section at the top listing failed " +
        "verifies, never-checked entries, and possible duplicates. Each bullet has a `key` and " +
        "a suggested CLI fix. Mention these to the user ONCE per session, briefly. After " +
        "mentioning, call `acknowledge_health(keys[])` with the keys you brought up — this is " +
        "how 'mention once' is enforced. Issues you don't acknowledge will reappear in the next " +
        "brief. Failed-verify entries with a ⚠ marker in the brief content sections are still " +
        "active rules/preferences — apply them; the marker just flags that a referenced " +
        "resource may have moved.\n\n" +
        "Every entry you write is automatically attributed to your agent (e.g. \"claude-code\", " +
        "\"cursor\"), so other agents can see who wrote what.",
    },
  )

  // Author resolution: env override wins, otherwise the MCP handshake's
  // clientInfo. Falls back to "mcp" if neither. Read lazily because
  // initialize happens after server construction.
  const resolveAuthor = (): string => {
    if (envAuthor) return envAuthor
    const info = server.server.getClientVersion()
    if (info?.name) {
      return info.version ? `${info.name}/${info.version}` : info.name
    }
    return "mcp"
  }

  server.registerTool(
    "list_context",
    {
      title: "List context entries",
      description:
        "List context entries with optional prefix, tag, and type filters. Expired entries " +
        "are excluded by default. Returns id, title, type, tags, timestamps, and a short preview.",
      inputSchema: {
        prefix: z.string().optional().describe('Filter by id prefix (e.g. "projects").'),
        tags: z.array(z.string()).optional().describe("Filter to entries that have ALL of these tags."),
        type: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Filter by entry type. Canonical: rule, preference, fact, decision, gotcha, project-state, reference.",
          ),
        author: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Filter by author. Matches entries where `author` starts with this name (e.g. "claude-code" matches "claude-code/1.2.3"). Useful for asking "what did Cursor write?".',
          ),
        limit: z.number().int().positive().max(200).optional(),
        includeExpired: z.boolean().optional(),
      },
    },
    async ({ prefix, tags, type, author, limit, includeExpired }) => {
      const results = await backend.list({ prefix, tags, type, author, limit, includeExpired })
      return jsonResult({ count: results.length, entries: results })
    },
  )

  server.registerTool(
    "read_context",
    {
      title: "Read a context entry",
      description:
        "Read the full content of a context entry by id. Returns markdown body, title, tags, and timestamps.",
      inputSchema: { id: ID_FIELD },
    },
    async ({ id }) => {
      try {
        return jsonResult(await backend.read(id))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    "write_context",
    {
      title: "Write a context entry",
      description:
        "Create or update a context entry. Use this to save durable facts about the user — identity, " +
        "preferences, ongoing projects, decisions, references to external systems. The body is markdown. " +
        "If an entry exists, it is overwritten and `updated` is bumped; `created` is preserved. " +
        "Choose ids that group naturally: user/identity, preferences/communication, projects/<name>. " +
        "Response includes `relatedExisting[]` when other entries cover similar ground — prefer " +
        "revising one of those over creating a duplicate.",
      inputSchema: {
        id: ID_FIELD,
        body: z.string().describe("Markdown body of the entry."),
        title: z.string().optional(),
        type: z
          .string()
          .optional()
          .describe(
            "Semantic type. Canonical values: rule, preference, fact, decision, gotcha, project-state, reference. Defaults to 'fact'.",
          ),
        tags: z.array(z.string()).optional(),
        supersedes: z
          .array(z.string())
          .optional()
          .describe("Ids of older entries this one replaces — preserves the link to history."),
        expires: z
          .string()
          .optional()
          .describe("ISO timestamp after which this entry is stale (filtered from default lists)."),
        verify: z
          .object({
            kind: z.enum(["url", "repo", "path"]),
            target: z.string().min(1),
          })
          .optional()
          .describe(
            "Optional reality check. `url` (HTTP 2xx), `repo` (GitHub owner/name, not archived), " +
              "or `path` (local filesystem exists). Run by `confirm_context`. Use it on entries " +
              "that reference external things that can rot — repos, dashboards, docs, file paths.",
          ),
      },
    },
    async ({ id, body, title, type, tags, supersedes, expires, verify }) => {
      try {
        const related = await findRelatedExisting(backend, id, body, title, tags)

        // Read existing for confirmation-appending. Tolerate not-found (new write).
        let previousConfirmations: Confirmation[] | undefined
        try {
          const existing = await backend.read(id)
          previousConfirmations = existing.confirmations
        } catch {
          // new entry
        }

        // Run the verify spec inline (short budget) so the agent sees the
        // outcome in the same response. Catches "you just wrote a memory
        // pointing at something that already doesn't exist."
        let verifyOutcome: {
          verifyStatus?: "ok" | "failed" | "unknown"
          verifyMessage?: string
          verifiedAt?: string
        } = {}
        if (verify) {
          try {
            // Inline verify keeps writes fast: tighten env-configured timeout
            // to a 3s ceiling. Background/CLI/`confirm_context` use the full
            // env-configured budget instead.
            const result = await runVerify(verify, { inlineBudgetMs: 3000 })
            verifyOutcome = {
              verifyStatus: result.status,
              verifiedAt: new Date().toISOString(),
              ...(result.message !== undefined ? { verifyMessage: result.message } : {}),
            }
          } catch {
            verifyOutcome = { verifyStatus: "unknown", verifiedAt: new Date().toISOString() }
          }
        }
        const author = resolveAuthor()
        const newConfirmation: Confirmation | null = verify
          ? { by: author, at: verifyOutcome.verifiedAt!, method: "verify" }
          : null
        const confirmations = newConfirmation
          ? [...(previousConfirmations ?? []), newConfirmation]
          : previousConfirmations
        const entry = await backend.write({
          id,
          body,
          title,
          type,
          tags,
          supersedes,
          expires,
          author,
          verify,
          ...verifyOutcome,
          ...(confirmations ? { confirmations } : {}),
        })
        return jsonResult({
          saved: true,
          entry,
          ...(related.length > 0 ? { relatedExisting: related } : {}),
          ...(verify && verifyOutcome.verifyStatus && verifyOutcome.verifyStatus !== "ok"
            ? {
                verifyWarning: `verify ${verifyOutcome.verifyStatus}: ${verifyOutcome.verifyMessage ?? "no detail"}`,
              }
            : {}),
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    "confirm_context",
    {
      title: "Confirm context entries are still accurate",
      description:
        "Call before ending your turn on entries you actually used. For each id: runs the entry's " +
        "`verify` block if present (HTTP, GitHub repo, or filesystem path) and records a " +
        "confirmation timestamp. Updates the entry's verifyStatus/verifiedAt/verifyMessage in place. " +
        "If verification fails, the entry stays in the store but is marked low-confidence; you " +
        "should immediately revise it via `write_context` to the same id with the corrected body.",
      inputSchema: {
        ids: z
          .array(ID_FIELD)
          .min(1)
          .describe("Entry ids you relied on this turn."),
      },
    },
    async ({ ids }) => {
      const results: Array<{
        id: string
        verifyStatus?: "ok" | "failed" | "unknown" | "skipped"
        verifyMessage?: string
        confirmedAt: string
        error?: string
      }> = []
      const author = resolveAuthor()
      const nowIso = new Date().toISOString()

      for (const id of ids) {
        try {
          const entry = await backend.read(id)
          let status: "ok" | "failed" | "unknown" | "skipped"
          let message: string | undefined
          if (entry.verify) {
            const result = await runVerify(entry.verify)
            status = result.status
            message = result.message
          } else {
            status = "skipped"
          }
          const confirmation: Confirmation = {
            by: author,
            at: nowIso,
            method: entry.verify ? "verify" : "use",
          }
          const nextConfirmations = [...(entry.confirmations ?? []), confirmation]
          await backend.write({
            id,
            body: entry.body,
            title: entry.title,
            type: entry.type,
            tags: entry.tags,
            supersedes: entry.supersedes,
            expires: entry.expires,
            author,
            verify: entry.verify,
            ...(entry.verify
              ? {
                  verifyStatus: status === "skipped" ? entry.verifyStatus : status,
                  verifiedAt: status === "skipped" ? entry.verifiedAt : nowIso,
                  ...(message !== undefined ? { verifyMessage: message } : {}),
                }
              : {}),
            confirmations: nextConfirmations,
          })
          results.push({
            id,
            verifyStatus: status,
            ...(message ? { verifyMessage: message } : {}),
            confirmedAt: nowIso,
          })
        } catch (e) {
          results.push({
            id,
            confirmedAt: nowIso,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      return jsonResult({ results })
    },
  )

  server.registerTool(
    "acknowledge_health",
    {
      title: "Acknowledge memory health issues",
      description:
        "Call this after mentioning memory health issues from the brief to the user (e.g. failed " +
        "verifies, possible duplicates). The acknowledged issues will be suppressed from the brief " +
        "for 7 days or until they change. Pass the `key` field of each issue you mentioned. " +
        "Acknowledging is how 'mention once per session, don't lecture' is actually enforced — " +
        "if you don't acknowledge, the next brief will repeat the same issues. When the backend " +
        "supports cross-device sync (mirror, http), acks propagate so the same issue doesn't get " +
        "repeated on the user's other machines either.",
      inputSchema: {
        keys: z
          .array(z.string().min(1))
          .min(1)
          .describe("Issue keys from the brief's Memory health section (e.g. 'failed:ref/old')."),
      },
    },
    async ({ keys }) => {
      try {
        const result = await recordAcks(keys, backend)
        return jsonResult({ acknowledged: result.added, at: result.at })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    "accept_context",
    {
      title: "Accept a known-failing verify",
      description:
        "Mark an entry's current failed verify state as expected — 'yes, that repo is archived " +
        "on purpose'. The entry stays in the store; it just stops appearing as a problem in the " +
        "brief's Memory health section. If the referenced resource later starts passing again, " +
        "the accepted flag clears automatically. Use this when the user explicitly tells you a " +
        "failure is intentional — never accept on their behalf without confirmation.",
      inputSchema: {
        id: ID_FIELD,
        reason: z
          .string()
          .optional()
          .describe(
            "Why this failure is expected. Stored alongside the entry so future agents (and `doctor --memory`) understand the intent.",
          ),
      },
    },
    async ({ id, reason }) => {
      try {
        const entry = await backend.read(id)
        if (!entry.verify) {
          return errorResult(new Error(`${id} has no verify block — nothing to accept`))
        }
        const author = resolveAuthor()
        const nowIso = new Date().toISOString()
        const saved = await backend.write({
          id,
          body: entry.body,
          title: entry.title,
          type: entry.type,
          tags: entry.tags,
          supersedes: entry.supersedes,
          expires: entry.expires,
          author,
          verify: entry.verify,
          verifyStatus: entry.verifyStatus,
          verifiedAt: entry.verifiedAt,
          ...(entry.verifyMessage !== undefined ? { verifyMessage: entry.verifyMessage } : {}),
          verifyAccepted: true,
          verifyAcceptedAt: nowIso,
          ...(reason ? { verifyAcceptedReason: reason } : {}),
          confirmations: [
            ...(entry.confirmations ?? []),
            { by: author, at: nowIso, method: "user" },
          ],
        })
        return jsonResult({
          accepted: true,
          id: saved.id,
          verifyStatus: saved.verifyStatus,
          verifyAccepted: saved.verifyAccepted,
          verifyAcceptedAt: saved.verifyAcceptedAt,
          ...(saved.verifyAcceptedReason ? { verifyAcceptedReason: saved.verifyAcceptedReason } : {}),
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    "merge_context",
    {
      title: "Merge two context entries",
      description:
        "Combine `from` into `into` and delete `from`. Use when the brief or `relatedExisting[]` " +
        "flags two entries that cover the same subject. By default the merged body is `into`'s " +
        "body with `from`'s body appended under a `---` divider; pass `body` to override with a " +
        "consolidated version you write yourself. The merge link is preserved via `supersedes` " +
        "so history is traceable.",
      inputSchema: {
        from: ID_FIELD.describe("The duplicate that will be deleted after merging."),
        into: ID_FIELD.describe("The canonical entry to keep."),
        body: z
          .string()
          .optional()
          .describe("Optional consolidated body. Defaults to into's body + '---' + from's body."),
      },
    },
    async ({ from, into, body }) => {
      try {
        if (from === into) {
          return errorResult(new Error("merge_context: from and into must differ"))
        }
        const [fromEntry, intoEntry] = await Promise.all([backend.read(from), backend.read(into)])
        const mergedBody =
          body !== undefined
            ? body
            : `${intoEntry.body.trim()}\n\n---\n\n${fromEntry.body.trim()}`
        const mergedTags = Array.from(new Set([...(intoEntry.tags ?? []), ...(fromEntry.tags ?? [])]))
        const supersedes = Array.from(
          new Set([...(intoEntry.supersedes ?? []), from]),
        )
        const author = resolveAuthor()
        const saved = await backend.write({
          id: into,
          body: mergedBody,
          title: intoEntry.title,
          type: intoEntry.type,
          tags: mergedTags,
          supersedes,
          expires: intoEntry.expires,
          author,
          verify: intoEntry.verify ?? fromEntry.verify,
          verifyStatus: intoEntry.verifyStatus ?? fromEntry.verifyStatus,
          verifiedAt: intoEntry.verifiedAt ?? fromEntry.verifiedAt,
          ...(intoEntry.verifyMessage !== undefined
            ? { verifyMessage: intoEntry.verifyMessage }
            : fromEntry.verifyMessage !== undefined
              ? { verifyMessage: fromEntry.verifyMessage }
              : {}),
        })
        await backend.delete(from)
        return jsonResult({ merged: true, into: saved.id, removed: from, entry: saved })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    "search_context",
    {
      title: "Search context entries",
      description:
        "Full-text search across all context entries. Matches against ids, titles, tags, and bodies. " +
        "Returns ranked hits with snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Search query. Multiple terms are AND-ed."),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const hits = await backend.search(query, { limit })
      return jsonResult({ count: hits.length, hits })
    },
  )

  server.registerTool(
    "list_tags",
    {
      title: "List all tags",
      description:
        "List every tag currently in use across all context entries, with usage counts. " +
        "Call this before inventing a new tag for write_context — reusing existing tags keeps the " +
        "store consistent and searchable.",
      inputSchema: {},
    },
    async () => {
      const tags = await backend.listTags()
      return jsonResult({ count: tags.length, tags })
    },
  )

  // ---- Resources: auto-loaded by MCP clients at session start ----

  server.registerResource(
    "nodus-context-brief",
    "nodus-context://brief",
    {
      title: "User context brief",
      description:
        "Always-relevant facts: rules the user has set, soft preferences, " +
        "and identity. Load this first to know how the user wants to be helped.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const brief = await renderBrief(backend, desc)
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: brief }],
      }
    },
  )

  server.registerResource(
    "nodus-context-entry",
    new ResourceTemplate("nodus-context://entry/{id}", {
      list: async () => {
        const entries = await backend.list()
        return {
          resources: entries.map((e) => ({
            uri: `nodus-context://entry/${e.id}`,
            name: e.id,
            title: e.title,
            description: renderResourceDescription(e),
            mimeType: "text/markdown",
          })),
        }
      },
    }),
    {
      title: "Context entry",
      description: "A single context entry rendered as markdown.",
      mimeType: "text/markdown",
    },
    async (uri, { id }) => {
      const entryId = typeof id === "string" ? id : String(id)
      try {
        const entry = await backend.read(entryId)
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: renderEntryMarkdown(entry),
            },
          ],
        }
      } catch (e) {
        if (e instanceof ContextNotFoundError) {
          throw new Error(`context entry not found: ${entryId}`)
        }
        throw e
      }
    },
  )

  server.registerTool(
    "delete_context",
    {
      title: "Delete a context entry",
      description:
        "Permanently delete a context entry by id. Use sparingly — prefer updating over deleting.",
      inputSchema: { id: ID_FIELD },
    },
    async ({ id }) => {
      try {
        await backend.delete(id)
        return jsonResult({ deleted: true, id })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const BRIEF_SECTION_CAP = 8

async function renderBrief(
  backend: ContextBackend,
  desc: import("../backends/index.js").BackendDescription,
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
  for (const [heading, entriesRaw] of sections) {
    // Order by recency, then cap so the brief stays token-friendly.
    // Failed-verify entries are SHOWN here with a ⚠ marker (not hidden) —
    // rules and preferences are load-bearing; a failed verify on a
    // referenced URL doesn't mean the rule itself no longer applies.
    // Memory health (above) flags the verify failure separately.
    const entries = entriesRaw.sort((a, b) => b.updated.localeCompare(a.updated))
    if (entries.length === 0) continue
    any = true
    lines.push(`## ${heading}`, "")
    const shown = entries.slice(0, BRIEF_SECTION_CAP)
    for (const e of shown) {
      const marker = entryHealthMarker(e)
      const markerPrefix = marker ? `${marker} ` : ""
      const tags = e.tags.length > 0 ? `  _[${e.tags.join(", ")}]_` : ""
      const author = e.author ? `  _by ${e.author}_` : ""
      lines.push(`- ${markerPrefix}**${e.id}**${tags}${author}`)
      if (e.preview) lines.push(`  ${e.preview}`)
    }
    if (entries.length > shown.length) {
      lines.push(
        `- _…and ${entries.length - shown.length} more — query with \`list_context\` if you need them_`,
      )
    }
    lines.push("")
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

interface RelatedExisting {
  /** Existing entry that overlaps the new write. */
  entry: ContextEntrySummary
  /**
   * `same-subject` — shares an id-prefix AND a tag with the new entry. Likely a
   * direct conflict; agent should prefer overwriting/superseding.
   * `similar` — lexically related but probably a sibling concept.
   */
  relation: "same-subject" | "similar"
}

/**
 * Looks for existing entries whose content materially overlaps a new write,
 * so the response can nudge the agent to revise instead of fork. Each hit is
 * tagged with a `relation` hint based on id-prefix + tag overlap, so the
 * agent knows when it's likely creating a duplicate vs. just a related fact.
 */
async function findRelatedExisting(
  backend: ContextBackend,
  newId: string,
  newBody: string,
  newTitle: string | undefined,
  newTags: string[] | undefined,
): Promise<RelatedExisting[]> {
  const queryParts: string[] = []
  if (newTitle) queryParts.push(newTitle)
  if (newTags && newTags.length > 0) queryParts.push(newTags.join(" "))
  const firstLine = newBody.split("\n").map((l) => l.trim()).find((l) => l.length > 0)
  if (firstLine) queryParts.push(firstLine.slice(0, 160))
  const query = queryParts.join(" ").trim()
  if (!query) return []
  try {
    const hits = await backend.search(query, { limit: 5 })
    const newPrefix = idPrefix(newId)
    const newTagSet = new Set(newTags ?? [])
    return hits
      .filter((h) => h.entry.id !== newId)
      .slice(0, 3)
      .map((h) => {
        const sameSubject =
          idPrefix(h.entry.id) === newPrefix &&
          h.entry.tags.some((t) => newTagSet.has(t))
        return {
          entry: h.entry,
          relation: sameSubject ? ("same-subject" as const) : ("similar" as const),
        }
      })
  } catch {
    return []
  }
}

function idPrefix(id: string): string {
  const i = id.indexOf("/")
  return i < 0 ? id : id.slice(0, i)
}

function renderResourceDescription(e: ContextEntrySummary): string {
  const parts = [e.type]
  if (e.tags.length > 0) parts.push(`tags: ${e.tags.join(", ")}`)
  if (e.expires) parts.push(`expires ${e.expires}`)
  return parts.join(" · ")
}

function renderEntryMarkdown(entry: ContextEntry): string {
  const meta: string[] = [`type: ${entry.type}`, `updated: ${entry.updated}`]
  if (entry.tags.length > 0) meta.push(`tags: ${entry.tags.join(", ")}`)
  if (entry.author) {
    meta.push(
      entry.createdBy && entry.createdBy !== entry.author
        ? `author: ${entry.author} (created by ${entry.createdBy})`
        : `author: ${entry.author}`,
    )
  }
  if (entry.supersedes && entry.supersedes.length > 0) meta.push(`supersedes: ${entry.supersedes.join(", ")}`)
  if (entry.expires) meta.push(`expires: ${entry.expires}`)
  if (entry.verify) meta.push(`verify: ${entry.verify.kind}:${entry.verify.target}`)
  if (entry.verifyStatus) {
    meta.push(
      entry.verifiedAt
        ? `verifyStatus: ${entry.verifyStatus} (${entry.verifiedAt})`
        : `verifyStatus: ${entry.verifyStatus}`,
    )
  }
  return `# ${entry.title}\n\n_${meta.join(" · ")}_\n\n${entry.body}`
}

function jsonResult(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  }
}

interface McpIcon {
  src: string
  mimeType?: string
  sizes?: string[]
}

/**
 * Load the Nodus avatar as MCP icons. SVG first (scalable, sharpest in
 * client UIs), PNG as a fallback for clients that don't render SVG.
 * Encoded as data URIs so clients never need network access to display
 * the icon. If the asset files are missing (shouldn't happen in a
 * published build), the server just starts without icons rather than
 * crashing — icons are cosmetic.
 */
function loadIcons(): McpIcon[] | undefined {
  try {
    // dist/mcp/server.js → ../../assets/
    const assetsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets")
    const svg = readFileSync(join(assetsRoot, "avatar.svg"))
    const png = readFileSync(join(assetsRoot, "avatar-1024.png"))
    return [
      {
        src: `data:image/svg+xml;base64,${svg.toString("base64")}`,
        mimeType: "image/svg+xml",
      },
      {
        src: `data:image/png;base64,${png.toString("base64")}`,
        mimeType: "image/png",
        sizes: ["1024x1024"],
      },
    ]
  } catch {
    return undefined
  }
}

function errorResult(e: unknown) {
  const message =
    e instanceof ContextNotFoundError ||
    e instanceof InvalidIdError ||
    e instanceof BodyTooLargeError ||
    e instanceof NotSupportedError ||
    e instanceof BackendError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e)
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  }
}

run().catch((e) => {
  console.error("nodus-context-mcp failed:", e)
  process.exit(1)
})
