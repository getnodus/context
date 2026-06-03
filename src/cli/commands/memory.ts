import { EntryType } from "../../backends/index.js"
import { recallContext, rememberContext, type MemoryScope } from "../../memory.js"
import { getBackend } from "../context.js"
import { readStdin, stdinIsTty } from "../stdin.js"
import { dim, green, info, renderHits, renderList } from "../output.js"

export interface RememberArgs {
  text?: string
  id?: string
  title?: string
  type?: EntryType
  tag?: string[]
  scope?: MemoryScope
  author?: string
  json?: boolean
}

export async function cmdRemember(args: RememberArgs): Promise<void> {
  const backend = await getBackend()
  let text = args.text
  if (text === undefined && !stdinIsTty()) text = await readStdin()
  if (!text?.trim()) {
    throw new Error("remember: provide text as arguments, --text, or stdin")
  }

  const result = await rememberContext(backend, {
    text,
    id: args.id,
    title: args.title,
    type: args.type,
    tags: args.tag,
    scope: args.scope,
    author: args.author ?? process.env.NODUS_CONTEXT_AGENT ?? "cli",
  })

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return
  }

  info(
    `${green(result.action)} ${result.entry.id} ${dim(
      `(${result.entry.type}, ${result.inferred.scope})`,
    )}`,
  )
  if (result.relatedExisting.length > 0) {
    info(dim(`related: ${result.relatedExisting.map((r) => r.entry.id).join(", ")}`))
  }
}

export interface RecallArgs {
  query?: string
  scope?: MemoryScope
  limit?: number
  json?: boolean
}

export async function cmdRecall(args: RecallArgs): Promise<void> {
  const backend = await getBackend()
  const result = await recallContext(backend, args)
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return
  }
  if (result.hits) {
    process.stdout.write(renderHits(result.hits) + "\n")
  } else {
    process.stdout.write(renderList(result.entries ?? []) + "\n")
  }
}
