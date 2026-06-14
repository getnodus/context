import {
  ContextBackend,
  ContextEntry,
  ContextNotFoundError,
} from "./backends/types.js"
import { toWriteInput, sameEntryContent } from "./backends/entry-utils.js"

export interface SyncBackendOptions {
  overwrite?: boolean
  dryRun?: boolean
  onCopy?: (entry: ContextEntry, direction: "forward" | "backward") => void
  onSkip?: (id: string, reason: "same-or-newer" | "same-content") => void
  onError?: (entry: ContextEntry, error: Error, direction: "forward" | "backward") => void
}

export interface SyncBackendResult {
  copied: number
  failed: number
  skipped: number
}

export interface ReconcileResult {
  forward: SyncBackendResult
  backward: SyncBackendResult
}

export async function syncBackends(
  source: ContextBackend,
  target: ContextBackend,
  options: SyncBackendOptions = {},
  direction: "forward" | "backward" = "forward",
): Promise<SyncBackendResult> {
  const sourceSummaries = await source.list({ sort: "id-asc", includeExpired: true })
  const targetSummaries = await target.list({ sort: "id-asc", includeExpired: true })
  const targetById = new Map(targetSummaries.map((entry) => [entry.id, entry]))

  let copied = 0
  let failed = 0
  let skipped = 0

  for (const summary of sourceSummaries) {
    const targetSummary = targetById.get(summary.id)
    if (!options.overwrite && targetSummary && targetSummary.updated >= summary.updated) {
      skipped++
      options.onSkip?.(summary.id, "same-or-newer")
      continue
    }

    const entry = await source.read(summary.id)
    if (targetSummary) {
      try {
        const targetEntry = await target.read(summary.id)
        if (sameEntryContent(entry, targetEntry)) {
          skipped++
          options.onSkip?.(summary.id, "same-content")
          continue
        }
      } catch (e) {
        // If target read fails after list saw the id, attempt the write below.
        // Log non-"not found" errors since they may indicate a real problem.
        if (!(e instanceof ContextNotFoundError)) {
          process.stderr.write(`[context] sync: could not read target entry ${summary.id}: ${e instanceof Error ? e.message : String(e)}\n`)
        }
      }
    }

    if (options.dryRun) {
      copied++
      options.onCopy?.(entry, direction)
      continue
    }

    try {
      await target.write(toWriteInput(entry))
      copied++
      options.onCopy?.(entry, direction)
    } catch (e) {
      failed++
      options.onError?.(entry, e as Error, direction)
    }
  }

  return { copied, failed, skipped }
}

export async function reconcileBackends(
  a: ContextBackend,
  b: ContextBackend,
  options: SyncBackendOptions = {},
): Promise<ReconcileResult> {
  const forward = await syncBackends(a, b, options, "forward")
  const backward = await syncBackends(b, a, options, "backward")
  return { forward, backward }
}

export { toWriteInput } from "./backends/entry-utils.js"
