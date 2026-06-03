import {
  ContextBackend,
  ContextEntry,
  ContextEntrySummary,
  EntryType,
  SearchHit,
} from "./backends/index.js"

export type MemoryScope = "global" | "workspace" | "project"

export interface RememberInput {
  text: string
  id?: string
  title?: string
  type?: EntryType
  tags?: string[]
  scope?: MemoryScope
  author?: string
}

export interface RememberResult {
  saved: true
  action: "created" | "updated"
  entry: ContextEntry
  inferred: {
    id: string
    title: string
    type: EntryType
    tags: string[]
    scope: MemoryScope
  }
  relatedExisting: Array<{ entry: ContextEntrySummary; relation: "updated" | "similar" }>
}

export interface RecallInput {
  query?: string
  scope?: MemoryScope
  limit?: number
}

export interface RecallResult {
  count: number
  entries?: ContextEntrySummary[]
  hits?: SearchHit[]
}

/**
 * Easy-path write API for agents and humans.
 *
 * Callers provide the memory as natural language; the helper chooses a stable
 * id, type, title, and tags. Advanced callers can still override those fields,
 * but the common path should not require agents to act as data modelers.
 */
export async function rememberContext(
  backend: ContextBackend,
  input: RememberInput,
): Promise<RememberResult> {
  const text = input.text.trim()
  if (!text) throw new Error("remember_context: text is empty")

  const type = input.type ?? inferType(text)
  const scope = input.scope ?? inferScope(type)
  const related = await findNaturalRelated(backend, text, type)
  const updateTarget = input.id ? undefined : pickUpdateTarget(related, type, text)
  const title = input.title ?? updateTarget?.entry.title ?? inferTitle(text)
  const tags = mergeTags(updateTarget?.entry.tags, input.tags, [scope, canonicalTypeTag(type)])
  const id = input.id ?? updateTarget?.entry.id ?? (await uniqueId(backend, prefixFor(type, scope), slugify(title)))
  const action = updateTarget ? "updated" : "created"

  const entry = await backend.write({
    id,
    title,
    type,
    tags,
    body: text,
    author: input.author,
  })

  return {
    saved: true,
    action,
    entry,
    inferred: { id, title, type, tags, scope },
    relatedExisting: related
      .filter((hit) => hit.entry.id !== id)
      .slice(0, 3)
      .map((hit) => ({ entry: hit.entry, relation: "similar" as const })),
  }
}

export async function recallContext(
  backend: ContextBackend,
  input: RecallInput,
): Promise<RecallResult> {
  const limit = input.limit ?? 8
  if (input.query?.trim()) {
    const hits = await backend.search(input.query.trim(), { limit })
    return { count: hits.length, hits }
  }
  const entries = await backend.list({
    tags: input.scope ? [input.scope] : undefined,
    limit,
  })
  return { count: entries.length, entries }
}

function inferType(text: string): EntryType {
  const lower = text.toLowerCase()
  if (/\b(always|never|must|do not|don't|dont|should always|required)\b/.test(lower)) {
    return "rule"
  }
  if (/\b(prefers?|preference|likes?|wants?|rather|tone|style)\b/.test(lower)) {
    return "preference"
  }
  if (/\b(decided|decision|chosen|choose|use .+ instead|standardized)\b/.test(lower)) {
    return "decision"
  }
  if (/\b(gotcha|warning|careful|broke|breaks|failed|fails|doesn't work|does not work)\b/.test(lower)) {
    return "gotcha"
  }
  if (/\b(currently|in progress|todo|next step|blocked|workspace|project)\b/.test(lower)) {
    return "project-state"
  }
  if (/\b(https?:\/\/|repo:|github\.com|file:|path:)\b/.test(lower)) {
    return "reference"
  }
  return "fact"
}

function inferScope(type: EntryType): MemoryScope {
  return type === "project-state" ? "project" : "global"
}

function inferTitle(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .find(Boolean)
  const title = (first ?? "Memory").replace(/\s+/g, " ").trim()
  return title.length > 80 ? title.slice(0, 77).trimEnd() + "..." : title
}

function prefixFor(type: EntryType, scope: MemoryScope): string {
  if (scope === "workspace") return "workspaces"
  if (scope === "project") return "projects"
  switch (type) {
    case "rule":
      return "rules"
    case "preference":
      return "preferences"
    case "decision":
      return "decisions"
    case "gotcha":
      return "gotchas"
    case "reference":
      return "references"
    default:
      return "facts"
  }
}

function canonicalTypeTag(type: EntryType): string {
  return String(type).replace(/[^a-z0-9]+/gi, "-").toLowerCase()
}

function mergeTags(...groups: Array<string[] | undefined>): string[] {
  const tags = new Set<string>()
  for (const group of groups) {
    for (const tag of group ?? []) {
      const normalized = tag.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
      if (normalized) tags.add(normalized)
    }
  }
  return Array.from(tags)
}

function slugify(text: string): string {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "should",
    "always",
    "never",
    "user",
    "users",
  ])
  const words = text
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !stop.has(word))
    .slice(0, 7)
  const slug = words.join("-").slice(0, 60).replace(/-+$/g, "")
  return slug || `memory-${Date.now()}`
}

async function uniqueId(backend: ContextBackend, prefix: string, slug: string): Promise<string> {
  const base = `${prefix}/${slug}`
  for (let i = 0; i < 100; i++) {
    const id = i === 0 ? base : `${base}-${i + 1}`
    try {
      await backend.read(id)
    } catch {
      return id
    }
  }
  return `${base}-${Date.now()}`
}

async function findNaturalRelated(
  backend: ContextBackend,
  text: string,
  type: EntryType,
): Promise<SearchHit[]> {
  try {
    const hits = await backend.search(text, { limit: 5 })
    return hits.filter((hit) => hit.entry.type === type || hit.score >= 8)
  } catch {
    return []
  }
}

function pickUpdateTarget(
  hits: SearchHit[],
  type: EntryType,
  text: string,
): SearchHit | undefined {
  const first = hits[0]
  if (!first || first.entry.type !== type) return undefined
  if (first.score >= 8) return first

  const queryWords = importantWords(text)
  const haystack = `${first.entry.id} ${first.entry.title} ${first.entry.preview}`.toLowerCase()
  const overlap = queryWords.filter((word) => haystack.includes(word)).length
  return queryWords.length >= 3 && overlap >= 3 ? first : undefined
}

function importantWords(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "user"])
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !stop.has(word)),
    ),
  ).slice(0, 8)
}
