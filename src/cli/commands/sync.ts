import { createBackend, ContextBackend, ContextEntry } from "../../backends/index.js"
import { loadConfig } from "../../config/index.js"
import { bold, cyan, dim, fail, green, info, red, yellow } from "../output.js"
import { confirm } from "../prompt.js"

export interface SyncArgs {
  direction: "push" | "pull"
  /** Profile to read from (push: source; pull: source). */
  from: string
  /** Profile to write to (push: target; pull: target). */
  to: string
  overwrite?: boolean
  dryRun?: boolean
  yes?: boolean
}

export async function cmdSync(args: SyncArgs): Promise<void> {
  const config = await loadConfig()
  const from = args.from === "__ACTIVE__" ? config.activeProfile : args.from
  const to = args.to === "__ACTIVE__" ? config.activeProfile : args.to
  args = { ...args, from, to }
  if (from === to) fail(`--from and --to resolve to the same profile (${from})`)
  if (!config.profiles[from]) fail(`no profile "${from}"`)
  if (!config.profiles[to]) fail(`no profile "${to}"`)

  const source = await openBackend(from, config.profiles[from])
  const target = await openBackend(to, config.profiles[to])

  info(bold(`nodus-context sync ${args.direction}`))
  info(`  ${dim("from:")}  ${cyan(from)}  ${dim(describeBackend(source))}`)
  info(`  ${dim("to:")}    ${cyan(to)}  ${dim(describeBackend(target))}`)
  if (args.dryRun) info(yellow("dry-run: no changes will be written"))
  info("")

  // Decide what to copy. For an idempotent reconcile, walk the source and
  // skip entries whose target version has an equal-or-newer `updated`
  // timestamp (unless --overwrite). New ids are copied; existing ones
  // are updated only when the source is strictly newer.
  const sourceSummaries = await source.list({ sort: "id-asc", includeExpired: true })
  const targetSummaries = await target.list({ sort: "id-asc", includeExpired: true })
  const targetByMap = new Map<string, { updated: string }>()
  for (const t of targetSummaries) targetByMap.set(t.id, { updated: t.updated })

  let toCopy: ContextEntry[] = []
  let skippedSameOrNewer = 0
  for (const s of sourceSummaries) {
    const tgt = targetByMap.get(s.id)
    if (!args.overwrite && tgt && tgt.updated >= s.updated) {
      skippedSameOrNewer++
      continue
    }
    toCopy.push(await source.read(s.id))
  }

  if (toCopy.length === 0) {
    info(green("up to date.") + dim(` (${skippedSameOrNewer} entries already in sync)`))
    return
  }

  info(`${toCopy.length} entries to copy${skippedSameOrNewer > 0 ? dim(`, ${skippedSameOrNewer} in sync`) : ""}`)
  if (!args.yes && !args.dryRun) {
    const ok = await confirm("proceed?", true)
    if (!ok) {
      info("aborted")
      return
    }
  }

  let ok = 0
  let failed = 0
  for (const entry of toCopy) {
    if (args.dryRun) {
      info(`  ${yellow("would copy")} ${entry.id}`)
      continue
    }
    try {
      await target.write({
        id: entry.id,
        body: entry.body,
        title: entry.title,
        type: entry.type,
        tags: entry.tags,
        supersedes: entry.supersedes,
        expires: entry.expires,
        author: entry.author,
      })
      ok++
      info(`  ${green("ok")}   ${entry.id}`)
    } catch (e) {
      failed++
      info(`  ${red("fail")} ${entry.id}: ${(e as Error).message}`)
    }
  }

  info("")
  info(`${green(`copied ${ok}`)}${failed > 0 ? red(`, ${failed} failed`) : ""}${skippedSameOrNewer > 0 ? dim(`, ${skippedSameOrNewer} in sync`) : ""}`)
}

async function openBackend(
  name: string,
  profile: import("../../backends/index.js").Profile,
): Promise<ContextBackend> {
  try {
    const backend = await createBackend(profile)
    await backend.init?.()
    return backend
  } catch (e) {
    fail(`could not open profile "${name}": ${(e as Error).message}`)
  }
}

function describeBackend(backend: ContextBackend): string {
  const d = backend.describe()
  return `${d.type} — ${d.label}`
}
