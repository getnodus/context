import { fileURLToPath } from "node:url"
import { ContextEntrySummary } from "../backends/index.js"

/**
 * Path segments that are common parents of project directories rather than the
 * project itself. Derived hints drop these so a repo at
 * `~/code/myrepo` yields the hint `myrepo`, not `code`.
 */
const STOP_SEGMENTS = new Set([
  "users",
  "home",
  "repos",
  "repositories",
  "workspaces",
  "workspace",
  "conductor",
  "projects",
  "project",
  "src",
  "code",
  "dev",
  "develop",
  "documents",
  "desktop",
  "downloads",
  "git",
  "github",
  "gitlab",
  "tmp",
  "var",
  "opt",
  "usr",
  "library",
])

/** Split a path into segments across both POSIX and Windows separators. */
function pathSegments(p: string): string[] {
  return p.split(/[/\\]+/).filter(Boolean)
}

/**
 * Turn workspace directory paths into matchable slugs. We take the leaf and its
 * parent (a repo is often `…/<repo>` and a Conductor workspace is
 * `…/<repo>/<branch>`, so both names are worth matching), lowercase them, and
 * drop generic container directories and dotfiles. Best-effort and pure —
 * unknown shapes simply yield fewer hints.
 */
export function deriveWorkspaceHints(paths: string[]): string[] {
  const hints = new Set<string>()
  for (const p of paths) {
    const segs = pathSegments(p)
    for (const seg of segs.slice(-2)) {
      const slug = seg.toLowerCase()
      if (!slug || slug.startsWith(".") || STOP_SEGMENTS.has(slug)) continue
      hints.add(slug)
    }
  }
  return [...hints]
}

/** Convert a `file://` root URI to a filesystem path; null for anything else. */
export function rootUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

/** An entry matches the workspace if a hint equals one of its id segments or tags. */
function matchesWorkspace(entry: ContextEntrySummary, hints: Set<string>): boolean {
  const idSegments = entry.id.toLowerCase().split(/[/\-_.]+/)
  for (const seg of idSegments) {
    if (hints.has(seg)) return true
  }
  for (const tag of entry.tags) {
    if (hints.has(tag.toLowerCase())) return true
  }
  return false
}

/**
 * Pick entries relevant to the current workspace, newest first. An entry
 * qualifies when one of `hints` exactly matches a segment of its id (split on
 * `/`, `-`, `_`, `.`) or one of its tags. `excludeIds` drops entries already
 * shown elsewhere in the brief so the workspace section never repeats them.
 * Returns the full match set (caller caps it) and an empty array when there
 * are no hints, so the feature is inert for clients that expose no workspace.
 */
export function selectWorkspaceEntries(
  all: ContextEntrySummary[],
  hints: string[],
  excludeIds: Set<string> = new Set(),
): ContextEntrySummary[] {
  if (hints.length === 0) return []
  const hintSet = new Set(hints.map((h) => h.toLowerCase()))
  return all
    .filter((e) => !excludeIds.has(e.id) && matchesWorkspace(e, hintSet))
    .sort((a, b) => b.updated.localeCompare(a.updated))
}
