import { createBackend, type Profile } from "../backends/index.js"
import { reconcileBackends } from "../sync.js"

export interface RemoteProbeResult {
  ok: boolean
  reachable: boolean
  error?: string
}

export interface InitialSyncSummary {
  copied: number
  failed: number
  skipped: number
}

export async function probeRemote(url: string, token?: string): Promise<RemoteProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    })
    if (res.ok) return { ok: true, reachable: true }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reachable: true, error: "server rejected the token" }
    }
    return { ok: false, reachable: true, error: `server returned ${res.status}` }
  } catch (e) {
    return { ok: false, reachable: false, error: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export async function reconcileProfileWithRemote(
  sourceProfile: Profile,
  remoteProfile: Extract<Profile, { type: "http" }>,
): Promise<InitialSyncSummary> {
  const source = await createBackend(sourceProfile)
  let remote: Awaited<ReturnType<typeof createBackend>> | undefined
  try {
    remote = await createBackend(remoteProfile)
    await source.init?.()
    await remote.init?.()
    const sync = await reconcileBackends(source, remote)
    return {
      copied: sync.forward.copied + sync.backward.copied,
      failed: sync.forward.failed + sync.backward.failed,
      skipped: sync.forward.skipped + sync.backward.skipped,
    }
  } finally {
    await source.close?.()
    await remote?.close?.()
  }
}
