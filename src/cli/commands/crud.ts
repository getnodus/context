import { ContextNotFoundError, VerifySpec } from "../../backends/index.js"
import { getBackend } from "../context.js"
import { readStdin, stdinIsTty } from "../stdin.js"
import { editInEditor } from "../editor.js"
import { fail, info, renderEntry, renderHits, renderList, green, dim } from "../output.js"

/**
 * Parse `--verify=kind:target` shorthand into a structured VerifySpec.
 *
 * Designed for AI agents teaching the user — easier to remember and to type
 * in conversation than asking the user to hand-edit YAML frontmatter:
 *
 *     context add ref/getnodus --verify=repo:getnodus/context
 *     context add ref/dashboard --verify=url:https://grafana.example.com/d/x
 *     context add ref/script --verify=path:~/bin/deploy.sh
 *
 * Returns null when the flag is omitted; throws via `fail` on malformed input.
 */
export function parseVerifyFlag(value?: string): VerifySpec | undefined {
  if (!value) return undefined
  const i = value.indexOf(":")
  if (i < 1) fail(`--verify must be kind:target (got ${value})`)
  const kind = value.slice(0, i).trim().toLowerCase()
  const target = value.slice(i + 1).trim()
  if (kind !== "url" && kind !== "repo" && kind !== "path") {
    fail(`--verify kind must be url, repo, or path (got ${kind})`)
  }
  if (!target) fail(`--verify target is empty (after kind:)`)
  return { kind: kind as VerifySpec["kind"], target }
}

export interface ListArgs {
  prefix?: string
  tag?: string[]
  type?: string[]
  author?: string[]
  limit?: number
  includeExpired?: boolean
  json?: boolean
}

export async function cmdList(args: ListArgs): Promise<void> {
  const backend = await getBackend()
  const entries = await backend.list({
    prefix: args.prefix,
    tags: args.tag,
    type: args.type,
    author: args.author,
    limit: args.limit,
    includeExpired: args.includeExpired,
  })
  if (args.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
  } else {
    process.stdout.write(renderList(entries) + "\n")
  }
}

export interface ShowArgs {
  id: string
  json?: boolean
}

export async function cmdShow(args: ShowArgs): Promise<void> {
  const backend = await getBackend()
  try {
    const entry = await backend.read(args.id)
    if (args.json) {
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n")
    } else {
      process.stdout.write(renderEntry(entry) + "\n")
    }
  } catch (e) {
    if (e instanceof ContextNotFoundError) fail(e.message)
    throw e
  }
}

export interface AddArgs {
  id: string
  title?: string
  type?: string
  tag?: string[]
  body?: string
  supersedes?: string[]
  expires?: string
  author?: string
  verify?: string
}

export async function cmdAdd(args: AddArgs): Promise<void> {
  const backend = await getBackend()

  let body = args.body
  if (body === undefined) {
    if (!stdinIsTty()) {
      body = await readStdin()
    } else {
      const placeholder = `# ${args.title ?? args.id}\n\n`
      body = await editInEditor(placeholder, `${args.id.replace(/\//g, "-")}.md`)
    }
  }

  body = body.trim()
  if (!body) fail("empty body — provide via --body, stdin, or editor")

  const author = args.author ?? process.env.NODUS_CONTEXT_AGENT ?? "cli"
  const verify = parseVerifyFlag(args.verify)

  const entry = await backend.write({
    id: args.id,
    body,
    title: args.title,
    type: args.type,
    tags: args.tag,
    supersedes: args.supersedes,
    expires: args.expires,
    author,
    ...(verify ? { verify } : {}),
  })
  const verifyTag = entry.verify ? ` ${dim(`· verify=${entry.verify.kind}:${entry.verify.target}`)}` : ""
  info(
    `${green("saved")} ${entry.id} ${dim(
      `(${entry.type}, ${entry.body.length} chars, by ${entry.author})`,
    )}${verifyTag}`,
  )
}

export async function cmdEdit(args: { id: string; verify?: string; clearVerify?: boolean }): Promise<void> {
  const backend = await getBackend()
  let current = ""
  let existing = true
  try {
    const entry = await backend.read(args.id)
    current = entry.body
  } catch (e) {
    if (e instanceof ContextNotFoundError) {
      existing = false
      current = `# ${args.id}\n\n`
    } else {
      throw e
    }
  }

  // When --verify is passed alone (no body changes), don't open the editor;
  // just attach/update the verify block. AI agents lean on this — they can
  // attach a verify block to an existing entry in one shot.
  if ((args.verify || args.clearVerify) && existing) {
    const verify = args.clearVerify ? undefined : parseVerifyFlag(args.verify)
    const entry = await backend.write({
      id: args.id,
      body: current.trim(),
      ...(verify ? { verify } : {}),
    })
    info(
      `${green("updated")} ${entry.id} ${dim(
        verify ? `· verify=${verify.kind}:${verify.target}` : "· verify cleared",
      )}`,
    )
    return
  }

  const updated = await editInEditor(current, `${args.id.replace(/\//g, "-")}.md`)
  const trimmed = updated.trim()
  if (!trimmed) fail("empty body — entry not saved")

  if (existing && trimmed === current.trim()) {
    info(dim("no changes"))
    return
  }

  const verify = parseVerifyFlag(args.verify)
  const entry = await backend.write({
    id: args.id,
    body: trimmed,
    ...(verify ? { verify } : {}),
  })
  info(`${green(existing ? "updated" : "created")} ${entry.id}`)
}

export interface SearchArgs {
  query: string
  limit?: number
  json?: boolean
}

export async function cmdSearch(args: SearchArgs): Promise<void> {
  const backend = await getBackend()
  const hits = await backend.search(args.query, { limit: args.limit })
  if (args.json) {
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n")
  } else {
    process.stdout.write(renderHits(hits) + "\n")
  }
}

export async function cmdDelete(args: { id: string }): Promise<void> {
  const backend = await getBackend()
  try {
    await backend.delete(args.id)
    info(`${green("deleted")} ${args.id}`)
  } catch (e) {
    if (e instanceof ContextNotFoundError) fail(e.message)
    throw e
  }
}
