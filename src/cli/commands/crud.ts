import { ContextNotFoundError } from "../../backends/index.js"
import { getBackend } from "../context.js"
import { readStdin, stdinIsTty } from "../stdin.js"
import { editInEditor } from "../editor.js"
import { fail, info, renderEntry, renderHits, renderList, green, dim } from "../output.js"

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

  const entry = await backend.write({
    id: args.id,
    body,
    title: args.title,
    type: args.type,
    tags: args.tag,
    supersedes: args.supersedes,
    expires: args.expires,
    author,
  })
  info(
    `${green("saved")} ${entry.id} ${dim(
      `(${entry.type}, ${entry.body.length} chars, by ${entry.author})`,
    )}`,
  )
}

export async function cmdEdit(args: { id: string }): Promise<void> {
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

  const updated = await editInEditor(current, `${args.id.replace(/\//g, "-")}.md`)
  const trimmed = updated.trim()
  if (!trimmed) fail("empty body — entry not saved")

  if (existing && trimmed === current.trim()) {
    info(dim("no changes"))
    return
  }

  const entry = await backend.write({ id: args.id, body: trimmed })
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
