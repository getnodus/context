import { ContextNotFoundError } from "../../backends/index.js"
import { getBackend } from "../context.js"
import { readStdin, stdinIsTty } from "../stdin.js"
import { bold, cyan, dim, fail, green, info } from "../output.js"

export interface MergeArgs {
  from: string
  into: string
  body?: string
  yes?: boolean
  author?: string
  json?: boolean
}

/**
 * `context merge <from> <into>` — combine two entries.
 *
 * Default body: into's body, a `---` divider, then from's body. Pass `--body`
 * or pipe to stdin to provide a hand-consolidated version instead. The merge
 * is recorded via `supersedes` so history stays traceable; `from` is deleted
 * after `into` is updated.
 *
 * Designed to be the one-liner fix for `doctor --memory` duplicate clusters
 * — copy the suggested command from the report and run it.
 */
export async function cmdMerge(args: MergeArgs): Promise<void> {
  if (args.from === args.into) {
    return fail("merge: <from> and <into> must differ")
  }
  const backend = await getBackend()

  let fromEntry, intoEntry
  try {
    fromEntry = await backend.read(args.from)
  } catch (e) {
    if (e instanceof ContextNotFoundError) return fail(`from entry not found: ${args.from}`)
    throw e
  }
  try {
    intoEntry = await backend.read(args.into)
  } catch (e) {
    if (e instanceof ContextNotFoundError) return fail(`into entry not found: ${args.into}`)
    throw e
  }

  let body = args.body
  if (body === undefined && !stdinIsTty()) {
    body = (await readStdin()).trim()
    if (!body) body = undefined
  }
  if (body === undefined) {
    body = `${intoEntry.body.trim()}\n\n---\n\n${fromEntry.body.trim()}`
  }

  const mergedTags = Array.from(new Set([...(intoEntry.tags ?? []), ...(fromEntry.tags ?? [])]))
  const supersedes = Array.from(new Set([...(intoEntry.supersedes ?? []), args.from]))
  const author = args.author ?? process.env.NODUS_CONTEXT_AGENT ?? "cli"

  const saved = await backend.write({
    id: args.into,
    body,
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
  await backend.delete(args.from)

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ merged: true, into: saved.id, removed: args.from, entry: saved }, null, 2) + "\n",
    )
    return
  }
  info(`${green("merged")} ${cyan(args.from)} → ${cyan(args.into)}`)
  info(dim(`  ${bold("body:")} ${saved.body.length} chars`))
  info(dim(`  ${bold("supersedes:")} ${(saved.supersedes ?? []).join(", ")}`))
  info(dim(`  ${bold("removed:")} ${args.from}`))
}
