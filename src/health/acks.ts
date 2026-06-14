import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { getNodusConfigDir } from "../backends/paths.js"
import type { HealthAckMap } from "../backends/health.js"
import type { ContextBackend } from "../backends/index.js"

/**
 * Where health acknowledgments are stored locally. Per machine, profile-agnostic
 * by design — the same physical store viewed from two profiles shouldn't be
 * told about the same problem twice on the same machine.
 *
 * When a backend implements ack sync (HTTP `/acks`, mirror), the brief layer
 * combines remote + local acks via {@link loadAcks(backend)}. The local file
 * is still written so offline acks Just Work.
 */
function ackFilePath(): string {
  return join(getNodusConfigDir(), ".cache", "health-acks.json")
}

/**
 * Read the local ack file. Returns empty on missing/malformed file; never
 * throws — acks are best-effort metadata, not durable state.
 */
export async function loadLocalAcks(): Promise<HealthAckMap> {
  try {
    const raw = await readFile(ackFilePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: HealthAckMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch (e: any) {
    // Missing file is expected on first run; other errors are noteworthy.
    if (e?.code !== "ENOENT" && !(e instanceof SyntaxError)) {
      process.stderr.write(`[context] warning: could not load health acks: ${e?.message ?? e}\n`)
    }
    return {}
  }
}

/**
 * Load acks for the brief. When a backend exposes ack sync, merge its acks
 * with the local file (latest timestamp wins per key) so acknowledging an
 * issue on device A suppresses it on device B. Falls back to local-only
 * when no backend is supplied or the backend doesn't support sync.
 */
export async function loadAcks(backend?: ContextBackend): Promise<HealthAckMap> {
  const local = await loadLocalAcks()
  if (!backend?.listAcks) return local
  let remote: HealthAckMap = {}
  try {
    remote = await backend.listAcks()
  } catch (e) {
    process.stderr.write(`[context] could not load remote acks, using local only: ${e instanceof Error ? e.message : String(e)}\n`)
    return local
  }
  const merged: HealthAckMap = { ...local }
  for (const [k, v] of Object.entries(remote)) {
    if (!merged[k] || v > merged[k]) merged[k] = v
  }
  return merged
}

/**
 * Record acks. Always writes locally so offline mention-once still works;
 * also forwards to the backend if it supports sync.
 */
export async function recordAcks(
  keys: string[],
  backend?: ContextBackend,
): Promise<{ added: number; at: string }> {
  const at = new Date().toISOString()
  if (keys.length === 0) return { added: 0, at }
  const file = ackFilePath()
  await mkdir(dirname(file), { recursive: true })
  const existing = await loadLocalAcks()
  let added = 0
  for (const key of keys) {
    if (!key || typeof key !== "string") continue
    if (!(key in existing)) added++
    existing[key] = at
  }
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8")
  await rename(tmp, file)

  // Fire-and-forget remote sync — local ack is the source of truth for
  // "did I tell the user yet"; remote is purely for cross-device suppression.
  if (backend?.recordAcks) {
    try {
      await backend.recordAcks(keys)
    } catch (e) {
      process.stderr.write(`[context] remote ack sync failed (will retry next time): ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  return { added: keys.length, at }
}

/** Test helper. Not exported beyond the module barrel. */
export async function clearAcks(): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises")
    await rm(ackFilePath(), { force: true })
  } catch {
    // ignore
  }
}
