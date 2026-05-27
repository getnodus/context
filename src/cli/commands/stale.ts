import { getBackend } from "../context.js"
import { bold, cyan, dim, info, yellow } from "../output.js"

export async function cmdStale(args: { days?: number; json?: boolean }): Promise<void> {
  const days = args.days ?? 90
  const backend = await getBackend()
  const entries = await backend.list({ includeExpired: true })
  const now = Date.now()
  const cutoff = now - days * 24 * 60 * 60 * 1000

  const expired = entries.filter((e) => e.expires && Date.parse(e.expires) <= now)
  const stale = entries.filter((e) => {
    if (e.expires && Date.parse(e.expires) <= now) return false
    if (!e.lastUsedAt) return Date.parse(e.updated) < cutoff
    return Date.parse(e.lastUsedAt) < cutoff
  })

  if (args.json) {
    process.stdout.write(JSON.stringify({ expired, stale }, null, 2) + "\n")
    return
  }

  if (expired.length > 0) {
    info(bold(`expired (${expired.length})`))
    for (const e of expired) {
      info(`  ${cyan(e.id)}  ${dim(`expired ${e.expires}`)}`)
    }
    info("")
  }
  if (stale.length > 0) {
    info(bold(`stale — unread for ${days}+ days (${stale.length})`))
    for (const e of stale) {
      const last = e.lastUsedAt ?? e.updated
      info(`  ${cyan(e.id)}  ${dim(`last touch ${last.slice(0, 10)}`)}`)
    }
    info("")
    info(dim(`review with: nodus-context show <id>`))
    info(dim(`delete with: nodus-context delete <id>`))
  }
  if (expired.length === 0 && stale.length === 0) {
    info(dim("nothing stale"))
  }
}
