import { getBackend } from "../context.js"
import { cyan, dim, info } from "../output.js"

export async function cmdTags(args: { json?: boolean }): Promise<void> {
  const backend = await getBackend()
  const tags = await backend.listTags()
  if (args.json) {
    process.stdout.write(JSON.stringify(tags, null, 2) + "\n")
    return
  }
  if (tags.length === 0) {
    info(dim("no tags yet"))
    return
  }
  const width = Math.max(...tags.map((t) => t.tag.length))
  for (const t of tags) {
    process.stdout.write(`${cyan(t.tag.padEnd(width))}  ${dim(String(t.count))}\n`)
  }
}
