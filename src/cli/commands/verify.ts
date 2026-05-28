import { Confirmation, ContextEntry } from "../../backends/index.js"
import { runVerify } from "../../backends/verify.js"
import { getBackend } from "../context.js"
import { bold, cyan, dim, green, info, red, yellow } from "../output.js"

export interface VerifyArgs {
  id?: string
  all?: boolean
  json?: boolean
}

interface VerifyOutcome {
  id: string
  status: "ok" | "failed" | "unknown" | "skipped"
  message?: string
  verifiedAt: string
}

export async function cmdVerify(args: VerifyArgs): Promise<void> {
  const backend = await getBackend()
  const nowIso = new Date().toISOString()

  let targets: ContextEntry[]
  if (args.id) {
    targets = [await backend.read(args.id)]
  } else if (args.all) {
    const summaries = await backend.list({ includeExpired: false })
    targets = []
    for (const s of summaries) {
      const entry = await backend.read(s.id)
      if (entry.verify) targets.push(entry)
    }
  } else {
    process.stderr.write("verify: pass <id> or --all\n")
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
      id: entry.id,
      body: entry.body,
      title: entry.title,
      type: entry.type,
      tags: entry.tags,
      supersedes: entry.supersedes,
      expires: entry.expires,
      author: "cli",
      verify: entry.verify,
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
    info(dim("review with: nodus-context show <id>"))
    info(dim("revise with: nodus-context edit <id>"))
  }
}
