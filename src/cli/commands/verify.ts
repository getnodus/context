import { Confirmation, ContextEntry, toWriteInput } from "../../backends/index.js"
import { runVerify } from "../../backends/verify.js"
import { getBackend } from "../context.js"
import { bold, cyan, dim, green, info, red, yellow } from "../output.js"

export interface VerifyArgs {
  id?: string
  all?: boolean
  failed?: boolean
  never?: boolean
  stale?: boolean
  force?: boolean
  json?: boolean
}

interface VerifyOutcome {
  id: string
  status: "ok" | "failed" | "unknown" | "skipped"
  message?: string
  verifiedAt: string
}

const STALE_VERIFY_MS = 30 * 24 * 60 * 60 * 1000

/**
 * `context verify` — run an entry's verify block.
 *
 * Targets (mutually compatible; entries matching any selector are verified):
 *   <id>      one specific entry
 *   --all     every entry that has a verify block (legacy behavior)
 *   --failed  re-check entries currently marked failed (and not accepted)
 *   --never   check entries that have a verify block but have never run
 *   --stale   re-check entries verified more than 30 days ago
 *
 * Accepted entries (`context accept <id>`) are skipped by `--all`/`--failed`
 * unless `--force` is set — they've been explicitly silenced by the user.
 */
export async function cmdVerify(args: VerifyArgs): Promise<void> {
  const backend = await getBackend()
  const nowIso = new Date().toISOString()
  const now = Date.parse(nowIso)

  let targets: ContextEntry[]
  if (args.id) {
    targets = [await backend.read(args.id)]
  } else if (args.all || args.failed || args.never || args.stale) {
    const summaries = await backend.list({ includeExpired: false })
    targets = []
    for (const s of summaries) {
      const entry = await backend.read(s.id)
      if (!entry.verify) continue
      if (entry.verifyAccepted && !args.force) continue
      let include = false
      if (args.all) include = true
      if (args.failed && entry.verifyStatus === "failed") include = true
      if (args.never && !entry.verifiedAt) include = true
      if (args.stale) {
        const age = entry.verifiedAt ? now - Date.parse(entry.verifiedAt) : Number.POSITIVE_INFINITY
        if (entry.verifyStatus === "ok" && Number.isFinite(age) && age > STALE_VERIFY_MS) include = true
      }
      if (include) targets.push(entry)
    }
  } else {
    process.stderr.write(
      "verify: pass <id>, --all, --failed, --never, or --stale\n" +
        "       (combine selectors freely; entries matching any are checked)\n",
    )
    process.exit(2)
  }

  const outcomes: VerifyOutcome[] = []
  for (const entry of targets) {
    if (!entry.verify) {
      outcomes.push({ id: entry.id, status: "skipped", verifiedAt: nowIso, message: "no verify block" })
      continue
    }
    const result = await runVerify(entry.verify)
    const confirmation: Confirmation = { by: "cli", at: nowIso, method: "verify" }
    const confirmations = [...(entry.confirmations ?? []), confirmation]
    await backend.write({
      ...toWriteInput(entry),
      author: "cli",
      verifyStatus: result.status,
      verifiedAt: nowIso,
      ...(result.message !== undefined ? { verifyMessage: result.message } : {}),
      confirmations,
    })
    outcomes.push({
      id: entry.id,
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
      verifiedAt: nowIso,
    })
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ results: outcomes }, null, 2) + "\n")
    return
  }

  if (outcomes.length === 0) {
    info(dim("nothing to verify"))
    return
  }
  for (const o of outcomes) {
    const tag =
      o.status === "ok"
        ? green("ok    ")
        : o.status === "failed"
          ? red("failed")
          : o.status === "unknown"
            ? yellow("unknown")
            : dim("skipped")
    info(`${tag}  ${cyan(o.id)}${o.message ? `  ${dim(o.message)}` : ""}`)
  }
  const failed = outcomes.filter((o) => o.status === "failed")
  if (failed.length > 0) {
    info("")
    info(bold(`${failed.length} entr${failed.length === 1 ? "y" : "ies"} failed verification.`))
    info(dim("review with: context show <id>"))
    info(dim("revise with: context edit <id>"))
    info(dim("accept (if expected): context accept <id>"))
  }
}
