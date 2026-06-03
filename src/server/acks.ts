import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { getDefaultLocalDir } from "../backends/paths.js"

export interface ServerAcksOptions {
  /** Store acks under this context root's .cache directory. */
  rootDir?: string
  /** Explicit ack file override. Primarily for tests. */
  file?: string
}

/**
 * Server-side ack store. Lives at `<context-dir>/.cache/server-acks.json` by
 * default; override the path with `NODUS_CONTEXT_ACKS_FILE`. Path is resolved
 * lazily so test runners that fiddle with env between cases see the change.
 */
function acksFilePath(options: ServerAcksOptions = {}): string {
  const override = options.file ?? process.env.NODUS_CONTEXT_ACKS_FILE
  if (override) return override
  return join(options.rootDir ?? getDefaultLocalDir(), ".cache", "server-acks.json")
}

export async function loadServerAcks(options: ServerAcksOptions = {}): Promise<Record<string, string>> {
  try {
    const raw = await readFile(acksFilePath(options), "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export async function recordServerAcks(
  keys: string[],
  options: ServerAcksOptions = {},
): Promise<{ added: number; at: string }> {
  const at = new Date().toISOString()
  if (keys.length === 0) return { added: 0, at }
  const file = acksFilePath(options)
  await mkdir(dirname(file), { recursive: true })
  const existing = await loadServerAcks(options)
  let added = 0
  for (const k of keys) {
    if (!k || typeof k !== "string") continue
    if (!(k in existing)) added++
    existing[k] = at
  }
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, JSON.stringify(existing, null, 2) + "\n", "utf8")
  await rename(tmp, file)
  return { added, at }
}
