import { readFile, writeFile } from "node:fs/promises"
import { getBackend } from "../context.js"
import { fail, info, green, dim, yellow } from "../output.js"

// `nodus-context-bundle` is the pre-rename format tag; still accepted on import.
type BundleFormat = "context-bundle" | "nodus-context-bundle"

interface Bundle {
  format: BundleFormat
  version: 1
  exportedAt: string
  entries: Array<{
    id: string
    title: string
    type?: string
    tags: string[]
    created: string
    updated: string
    body: string
    supersedes?: string[]
    expires?: string
    author?: string
    createdBy?: string
  }>
}

export async function cmdExport(args: { out?: string }): Promise<void> {
  const backend = await getBackend()
  const summaries = await backend.list({ sort: "id-asc" })
  const entries: Bundle["entries"] = []
  for (const s of summaries) {
    const full = await backend.read(s.id)
    entries.push({
      id: full.id,
      title: full.title,
      type: full.type,
      tags: full.tags,
      created: full.created,
      updated: full.updated,
      body: full.body,
      ...(full.supersedes && full.supersedes.length > 0 ? { supersedes: full.supersedes } : {}),
      ...(full.expires ? { expires: full.expires } : {}),
      ...(full.author ? { author: full.author } : {}),
      ...(full.createdBy ? { createdBy: full.createdBy } : {}),
    })
  }

  const bundle: Bundle = {
    format: "context-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  }

  const json = JSON.stringify(bundle, null, 2)
  if (args.out) {
    await writeFile(args.out, json + "\n", "utf8")
    info(`${green("exported")} ${entries.length} entries to ${args.out}`)
  } else {
    process.stdout.write(json + "\n")
  }
}

export async function cmdImport(args: { file: string; overwrite?: boolean }): Promise<void> {
  let raw: string
  try {
    raw = await readFile(args.file, "utf8")
  } catch (e: any) {
    fail(`could not read ${args.file}: ${e.message}`)
  }

  let bundle: Bundle
  try {
    bundle = JSON.parse(raw)
  } catch (e) {
    fail(`could not parse ${args.file} as JSON: ${(e as Error).message}`)
  }

  if (bundle.format !== "context-bundle" && bundle.format !== "nodus-context-bundle") {
    fail(`not a context bundle (format=${bundle.format})`)
  }
  if (bundle.version !== 1) {
    fail(`unsupported bundle version ${bundle.version}`)
  }

  const backend = await getBackend()
  let imported = 0
  let skipped = 0

  // Look up existing ids via list() instead of read() — read() records a
  // use on backends that track usage, which would corrupt the post-import
  // stale view by bumping every skipped entry.
  const existingIds = args.overwrite
    ? null
    : new Set((await backend.list({ sort: "id-asc" })).map((e) => e.id))

  for (const e of bundle.entries) {
    if (existingIds && existingIds.has(e.id)) {
      skipped++
      info(`  ${dim("skip")}   ${e.id} ${yellow("(exists, use --overwrite)")}`)
      continue
    }
    await backend.write({
      id: e.id,
      body: e.body,
      title: e.title,
      type: e.type,
      tags: e.tags,
      supersedes: e.supersedes,
      expires: e.expires,
      author: e.author,
    })
    imported++
    info(`  ${green("ok")}    ${e.id}`)
  }

  info("")
  info(`${green("imported")} ${imported}  ${dim(`(skipped ${skipped})`)}`)
}
