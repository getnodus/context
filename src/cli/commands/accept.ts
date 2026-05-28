import { ContextNotFoundError } from "../../backends/index.js"
import { getBackend } from "../context.js"
import { bold, cyan, dim, fail, green, info } from "../output.js"

export interface AcceptArgs {
  id: string
  reason?: string
  unaccept?: boolean
  author?: string
  json?: boolean
}

/**
 * `context accept <id>` — silence a known-failing verify.
 *
 * The escape hatch for "yes, that repo is archived on purpose" cases. Sets
 * `verifyAccepted: true` on the entry; the brief and `doctor --memory` will
 * move it from the failed bucket to an informational "accepted" bucket.
 * A later passing verify auto-clears the accept (nothing left to suppress).
 *
 * `--unaccept` reverses it. Useful if the user changes their mind and wants
 * to see the verify failure again.
 */
export async function cmdAccept(args: AcceptArgs): Promise<void> {
  const backend = await getBackend()
  let entry
  try {
    entry = await backend.read(args.id)
  } catch (e) {
    if (e instanceof ContextNotFoundError) return fail(e.message)
    throw e
  }
  if (!entry.verify) {
    return fail(`${args.id} has no verify block — nothing to accept or unaccept`)
  }
  const author = args.author ?? process.env.NODUS_CONTEXT_AGENT ?? "cli"
  const nowIso = new Date().toISOString()
  const saved = await backend.write({
    id: entry.id,
    body: entry.body,
    title: entry.title,
    type: entry.type,
    tags: entry.tags,
    supersedes: entry.supersedes,
    expires: entry.expires,
    author,
    verify: entry.verify,
    verifyStatus: entry.verifyStatus,
    verifiedAt: entry.verifiedAt,
    ...(entry.verifyMessage !== undefined ? { verifyMessage: entry.verifyMessage } : {}),
    verifyAccepted: !args.unaccept,
    ...(!args.unaccept ? { verifyAcceptedAt: nowIso } : {}),
    ...(args.reason && !args.unaccept ? { verifyAcceptedReason: args.reason } : {}),
    confirmations: [
      ...(entry.confirmations ?? []),
      { by: author, at: nowIso, method: "user" },
    ],
  })

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          id: saved.id,
          verifyStatus: saved.verifyStatus,
          verifyAccepted: saved.verifyAccepted ?? false,
          ...(saved.verifyAcceptedAt ? { verifyAcceptedAt: saved.verifyAcceptedAt } : {}),
          ...(saved.verifyAcceptedReason ? { verifyAcceptedReason: saved.verifyAcceptedReason } : {}),
        },
        null,
        2,
      ) + "\n",
    )
    return
  }

  if (args.unaccept) {
    info(`${green("unaccepted")} ${cyan(saved.id)} — verify failures will resurface`)
  } else {
    const reasonPart = args.reason ? `  ${dim(`(${args.reason})`)}` : ""
    info(`${green("accepted")} ${cyan(saved.id)}${reasonPart}`)
    info(dim(`  ${bold("note:")} a passing verify will auto-clear this`))
  }
}
