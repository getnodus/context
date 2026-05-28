import { ContextEntry, SearchHit } from "./types.js"
import { computeConfidence } from "./confidence.js"

/**
 * BM25-based lexical search over context entries.
 *
 * Beats raw substring matching on the things users actually want:
 *   - tolerates word order ("amsterdam coffee" matches "coffee in amsterdam")
 *   - prefix matches ("amsterd" → "amsterdam")
 *   - field boosts (id and title weigh more than body)
 *   - rarity-aware ranking (a query term that appears in 1 entry beats a common one)
 *
 * Zero dependencies, no setup, fast enough for tens of thousands of entries.
 */

const FIELD_WEIGHTS = {
  id: 3.0,
  title: 2.0,
  tags: 1.5,
  body: 1.0,
} as const

const K1 = 1.2
const B = 0.75

const PREFIX_BONUS = 0.3
const MIN_TOKEN_LEN = 2

export interface LexicalSearchOptions {
  limit?: number
}

export function lexicalSearch(
  query: string,
  entries: ContextEntry[],
  options: LexicalSearchOptions = {},
): SearchHit[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0 || entries.length === 0) return []

  const docs = entries.map((entry) => buildDoc(entry))
  const avgDocLen = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1

  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of doc.uniqueTerms) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  const N = docs.length
  const idf = (term: string): number => {
    const n = df.get(term) ?? 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }

  const hits: SearchHit[] = []
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]
    const entry = entries[i]
    let score = 0
    let matched = 0

    for (const qt of queryTerms) {
      const tf = doc.tf.get(qt) ?? 0
      if (tf > 0) {
        score += idf(qt) * bm25Component(tf, doc.length, avgDocLen)
        matched++
        continue
      }
      // Prefix fallback: any document term that starts with qt contributes
      // a fraction of a full match. Catches typos and partial words.
      let prefixTf = 0
      let prefixIdf = 0
      for (const [term, count] of doc.tf.entries()) {
        if (term.length > qt.length && term.startsWith(qt)) {
          prefixTf += count
          const i = idf(term)
          if (i > prefixIdf) prefixIdf = i
        }
      }
      if (prefixTf > 0) {
        score += PREFIX_BONUS * prefixIdf * bm25Component(prefixTf, doc.length, avgDocLen)
        matched++
      }
    }

    if (matched === 0) continue
    if (queryTerms.length > 1) {
      score *= matched / queryTerms.length
    }

    hits.push({
      entry: summarize(entry),
      score,
      snippets: makeSnippets(entry, queryTerms),
      confidence: computeConfidence(entry),
    })
  }

  hits.sort((a, b) => b.score - a.score)
  return options.limit ? hits.slice(0, options.limit) : hits
}

function bm25Component(tf: number, docLen: number, avgDocLen: number): number {
  return (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / avgDocLen)))
}

interface Doc {
  tf: Map<string, number>
  uniqueTerms: string[]
  length: number
}

function buildDoc(entry: ContextEntry): Doc {
  const tf = new Map<string, number>()
  add(tf, tokenize(entry.id), FIELD_WEIGHTS.id)
  add(tf, tokenize(entry.title), FIELD_WEIGHTS.title)
  add(tf, tokenize(entry.tags.join(" ")), FIELD_WEIGHTS.tags)
  add(tf, tokenize(entry.body), FIELD_WEIGHTS.body)

  let length = 0
  for (const v of tf.values()) length += v
  return { tf, uniqueTerms: Array.from(tf.keys()), length }
}

function add(tf: Map<string, number>, terms: string[], weight: number): void {
  for (const term of terms) {
    tf.set(term, (tf.get(term) ?? 0) + weight)
  }
}

export function tokenize(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  // Split camelCase: "lastUsedAt" → "last Used At"
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
  for (const raw of split.split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LEN) out.push(raw)
  }
  return out
}

function makeSnippets(entry: ContextEntry, queryTerms: string[]): string[] {
  const body = entry.body
  if (!body) return []
  const lower = body.toLowerCase()
  const snippets: string[] = []
  const seen = new Set<number>()

  for (const term of queryTerms) {
    const at = lower.indexOf(term)
    if (at < 0) continue
    const start = Math.max(0, at - 40)
    if (seen.has(start)) continue
    seen.add(start)
    const end = Math.min(body.length, at + term.length + 80)
    snippets.push(snippet(body, start, end))
    if (snippets.length >= 3) break
  }
  return snippets
}

function snippet(body: string, start: number, end: number): string {
  const text = body.slice(start, end).replace(/\s+/g, " ").trim()
  const prefix = start > 0 ? "..." : ""
  const suffix = end < body.length ? "..." : ""
  return prefix + text + suffix
}

function summarize(entry: ContextEntry): SearchHit["entry"] {
  const trimmed = entry.body.trim()
  const preview =
    trimmed.length > 160 ? trimmed.slice(0, 157).trimEnd() + "..." : trimmed
  return {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    tags: entry.tags,
    created: entry.created,
    updated: entry.updated,
    preview,
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    ...(entry.expires ? { expires: entry.expires } : {}),
    ...(entry.author ? { author: entry.author } : {}),
    ...(entry.createdBy ? { createdBy: entry.createdBy } : {}),
    ...(entry.verify ? { verify: entry.verify } : {}),
    ...(entry.verifiedAt ? { verifiedAt: entry.verifiedAt } : {}),
    ...(entry.verifyStatus ? { verifyStatus: entry.verifyStatus } : {}),
    ...(entry.verifyMessage ? { verifyMessage: entry.verifyMessage } : {}),
  }
}
