import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { getNodusConfigDir } from "../backends/paths.js"
import type { HealthAckMap } from "../backends/health.js"

/**
 * Where health acknowledgments are stored. Per machine, profile-agnostic by
 * design — the same physical store viewed from two profiles shouldn't be
 * told about the same problem twice on the same machine.
 */
function ackFilePath(): string {
  return join(getNodusConfigDir(), ".cache", "health-acks.json")
}

export async function loadAcks(): Promise<HealthAckMap> {
  try {
    const raw = await readFile(ackFilePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: HealthAckMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export async function recordAcks(keys: string[]): Promise<{ added: number; at: string }> {
  if (keys.length === 0) return { added: 0, at: new Date().toISOString() }
  const file = ackFilePath()
  await mkdir(dirname(file), { recursive: true })
  const existing = await loadAcks()
  const at = new Date().toISOString()
  let added = 0
  for (const key of keys) {
    if (!key || typeof key !== "string") continue
    if (!(key in existing)) added++
    existing[key] = at
  }
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8")
  await rename(tmp, file)
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
