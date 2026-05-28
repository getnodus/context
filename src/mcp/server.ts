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
  ContextEntrySummary,
} from "../backends/index.js"
import { getActiveProfile } from "../config/index.js"
import { packageVersion } from "../cli/version.js"

const ID_FIELD = z
  .string()
  .min(1)
  .describe(
    'Path-style identifier for the context entry, e.g. "user/identity" or "projects/nodus". ' +
      "Use lowercase, alphanumeric segments separated by /.",
  )

export async function run() {
  const { profile } = await getActiveProfile()
  const backend = await createBackend(profile)
  await backend.init?.()
  const desc = backend.describe()

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
        "  - list_tags — see existing tags before inventing new ones\n\n" +
        "Entry id convention: path-style, e.g. `user/identity`, `preferences/communication`, " +
        "`projects/<name>`, `decisions/<date>-<topic>`. When superseding a prior entry, " +
        "pass its id in the `supersedes` field on write so the link is recorded.\n\n" +
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
        "Choose ids that group naturally: user/identity, preferences/communication, projects/<name>.",
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
      },
    },
    async ({ id, body, title, type, tags, supersedes, expires }) => {
      try {
        const entry = await backend.write({
          id,
          body,
          title,
          type,
          tags,
          supersedes,
          expires,
          author: resolveAuthor(),
        })
        return jsonResult({ saved: true, entry })
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

async function renderBrief(
  backend: ContextBackend,
  desc: import("../backends/index.js").BackendDescription,
): Promise<string> {
  const [rules, preferences, identity, all] = await Promise.all([
    backend.list({ type: "rule" }),
    backend.list({ type: "preference" }),
    backend.list({ prefix: "user/" }),
    backend.list(),
  ])

  const caps: string[] = []
  if (desc.capabilities.history) caps.push("history")
  if (desc.capabilities.semanticSearch) caps.push("semantic search")
  const capStr = caps.length > 0 ? ` · ${caps.join(", ")}` : ""

  const lines: string[] = [
    "# User context brief",
    "",
    `_Backend: **${desc.type}** — ${desc.label} · ${all.length} entries${capStr}_`,
    "",
  ]
  const sections: Array<[string, ContextEntrySummary[]]> = [
    ["Rules (must follow)", rules],
    ["Preferences (respect when possible)", preferences],
    ["Identity", identity.filter((e) => e.type !== "rule" && e.type !== "preference")],
  ]

  let any = false
  for (const [heading, entries] of sections) {
    if (entries.length === 0) continue
    any = true
    lines.push(`## ${heading}`, "")
    for (const e of entries) {
      const tags = e.tags.length > 0 ? `  _[${e.tags.join(", ")}]_` : ""
      const author = e.author ? `  _by ${e.author}_` : ""
      lines.push(`- **${e.id}**${tags}${author}`)
      if (e.preview) lines.push(`  ${e.preview}`)
    }
    lines.push("")
  }

  if (!any) {
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

function renderResourceDescription(e: ContextEntrySummary): string {
  const parts = [e.type]
  if (e.tags.length > 0) parts.push(`tags: ${e.tags.join(", ")}`)
  if (e.expires) parts.push(`expires ${e.expires}`)
  return parts.join(" · ")
}

function renderEntryMarkdown(entry: import("../backends/index.js").ContextEntry): string {
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
