import { isatty } from "node:tty"
import type { ContextEntry, ContextEntrySummary, SearchHit } from "../backends/index.js"

const useColor = isatty(1) && !process.env.NO_COLOR

function color(code: string, text: string): string {
  if (!useColor) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

export const dim = (s: string) => color("2", s)
export const bold = (s: string) => color("1", s)
export const cyan = (s: string) => color("36", s)
export const yellow = (s: string) => color("33", s)
export const red = (s: string) => color("31", s)
export const green = (s: string) => color("32", s)
export const magenta = (s: string) => color("35", s)

export function fail(msg: string): never {
  process.stderr.write(red("error: ") + msg + "\n")
  process.exit(1)
}

export function info(msg: string): void {
  process.stderr.write(msg + "\n")
}

export function renderList(entries: ContextEntrySummary[]): string {
  if (entries.length === 0) {
    return dim("no entries")
  }
  const idWidth = Math.min(40, Math.max(...entries.map((e) => e.id.length)))
  const typeWidth = Math.max(...entries.map((e) => e.type?.length ?? 4))
  const lines: string[] = []
  for (const e of entries) {
    const id = e.id.padEnd(idWidth)
    const type = (e.type ?? "fact").padEnd(typeWidth)
    const tags = e.tags.length > 0 ? "  " + dim(`[${e.tags.join(", ")}]`) : ""
    const preview = e.preview ? "  " + dim(e.preview) : ""
    lines.push(cyan(id) + "  " + magenta(type) + tags + preview)
  }
  return lines.join("\n")
}

export function renderEntry(entry: ContextEntry): string {
  const lines = [
    bold(entry.title),
    dim(`id: ${entry.id}`),
    dim(`type: ${entry.type}`),
    dim(`tags: ${entry.tags.length > 0 ? entry.tags.join(", ") : "(none)"}`),
    dim(`updated: ${entry.updated}`),
  ]
  if (entry.author) {
    const origin =
      entry.createdBy && entry.createdBy !== entry.author
        ? `${entry.author} (created by ${entry.createdBy})`
        : entry.author
    lines.push(dim(`author: ${origin}`))
  }
  if (entry.supersedes && entry.supersedes.length > 0) {
    lines.push(dim(`supersedes: ${entry.supersedes.join(", ")}`))
  }
  if (entry.expires) lines.push(dim(`expires: ${entry.expires}`))
  if (entry.useCount !== undefined) {
    lines.push(dim(`use count: ${entry.useCount}  last: ${entry.lastUsedAt ?? "never"}`))
  }
  lines.push("", entry.body.trim())
  return lines.join("\n")
}

export function renderHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return dim("no matches")
  }
  const lines: string[] = []
  for (const h of hits) {
    lines.push(`${cyan(h.entry.id)}  ${dim("(score " + h.score + ")")}`)
    for (const s of h.snippets) {
      lines.push("  " + dim(s))
    }
  }
  return lines.join("\n")
}
