import { createBackend, ContextBackend } from "../../backends/index.js"
import { loadConfig } from "../../config/index.js"
import { bold, cyan, dim, fail, green, info, red, yellow } from "../output.js"
import { confirm } from "../prompt.js"
import { reconcileBackends, syncBackends } from "../../sync.js"

export interface SyncArgs {
  direction: "push" | "pull" | "reconcile"
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

  const sourceCount = (await source.list({ includeExpired: true })).length
  const targetCount = (await target.list({ includeExpired: true })).length
  info(`${sourceCount} source entries, ${targetCount} target entries`)
  if (!args.yes && !args.dryRun) {
    const ok = await confirm("proceed?", true)
    if (!ok) {
      info("aborted")
      return
    }
  }

  const callbacks = {
    onCopy: (entry: { id: string }, direction: "forward" | "backward") => {
      const label = args.dryRun ? yellow("would copy") : green("ok")
      const arrow = direction === "forward" ? `${from}→${to}` : `${to}→${from}`
      info(`  ${label} ${dim(arrow)} ${entry.id}`)
    },
    onError: (entry: { id: string }, e: Error, direction: "forward" | "backward") => {
      const arrow = direction === "forward" ? `${from}→${to}` : `${to}→${from}`
      info(`  ${red("fail")} ${dim(arrow)} ${entry.id}: ${e.message}`)
    },
  }

  const result =
    args.direction === "reconcile"
      ? await reconcileBackends(source, target, { overwrite: args.overwrite, dryRun: args.dryRun, ...callbacks })
      : { forward: await syncBackends(source, target, { overwrite: args.overwrite, dryRun: args.dryRun, ...callbacks }), backward: { copied: 0, failed: 0, skipped: 0 } }

  const copied = result.forward.copied + result.backward.copied
  const failed = result.forward.failed + result.backward.failed
  const skipped = result.forward.skipped + result.backward.skipped
  info("")
  info(`${green(`copied ${copied}`)}${failed > 0 ? red(`, ${failed} failed`) : ""}${skipped > 0 ? dim(`, ${skipped} in sync`) : ""}`)
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
