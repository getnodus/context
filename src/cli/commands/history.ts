import { NotSupportedError } from "../../backends/index.js"
import { getBackend } from "../context.js"
import { bold, cyan, dim, green, info, red, fail } from "../output.js"

function ensureHistory(supported: boolean): void {
  if (!supported) {
    fail("the active backend does not support history")
  }
}

export async function cmdHistory(args: { id: string; json?: boolean }): Promise<void> {
  const backend = await getBackend()
  ensureHistory(backend.describe().capabilities.history && !!backend.listHistory)
  const snapshots = await backend.listHistory!(args.id)
  if (args.json) {
    process.stdout.write(JSON.stringify(snapshots, null, 2) + "\n")
    return
  }
  if (snapshots.length === 0) {
    info(dim(`no history for ${args.id}`))
    return
  }
  info(bold(`history for ${args.id}`))
  for (const s of snapshots) {
    const marker = s.deletion ? red("deleted") : cyan("changed")
    info(`  ${marker}  ${s.timestamp}  ${dim(s.file)}`)
  }
  info("")
  info(dim(`revert with: context revert ${args.id} [--at=<file>]`))
}

export async function cmdRevert(args: { id: string; at?: string }): Promise<void> {
  const backend = await getBackend()
  ensureHistory(backend.describe().capabilities.history && !!backend.revert)
  try {
    const entry = await backend.revert!(args.id, args.at)
    info(`${green("reverted")} ${entry.id}  ${dim(`(${entry.body.length} chars)`)}`)
  } catch (e) {
    if (e instanceof NotSupportedError) fail(e.message)
    fail((e as Error).message)
  }
}

export async function cmdShowSnapshot(args: { id: string; at: string }): Promise<void> {
  const backend = await getBackend()
  ensureHistory(backend.describe().capabilities.history && !!backend.readSnapshot)
  try {
    const entry = await backend.readSnapshot!(args.id, args.at)
    process.stdout.write(entry.body + "\n")
  } catch (e) {
    if (e instanceof NotSupportedError) fail(e.message)
    fail((e as Error).message)
  }
}
