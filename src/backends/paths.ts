import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

const ID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i

export function getDefaultLocalDir(): string {
  if (process.env.NODUS_CONTEXT_DIR) {
    return resolve(process.env.NODUS_CONTEXT_DIR)
  }
  return join(homedir(), ".nodus", "context")
}

export function getNodusConfigDir(): string {
  if (process.env.NODUS_CONFIG_DIR) {
    return resolve(process.env.NODUS_CONFIG_DIR)
  }
  return join(homedir(), ".nodus")
}

export function validateId(id: string): void {
  if (!id || id.length === 0) {
    throw new Error("id must be non-empty")
  }
  if (id.length > 200) {
    throw new Error("id is too long (max 200 chars)")
  }
  if (id.startsWith("/") || id.endsWith("/")) {
    throw new Error("id must not start or end with /")
  }
  if (id.includes("//")) {
    throw new Error("id must not contain //")
  }
  if (id.includes("..")) {
    throw new Error("id must not contain ..")
  }
  for (const segment of id.split("/")) {
    if (!ID_SEGMENT.test(segment)) {
      throw new Error(
        `id segment "${segment}" must be alphanumeric with -, _, or .`,
      )
    }
  }
}

export function idToPath(rootDir: string, id: string): string {
  validateId(id)
  const rootResolved = resolve(rootDir)
  const full = resolve(rootResolved, `${id}.md`)
  const rel = relative(rootResolved, full)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`id "${id}" resolves outside of context root`)
  }
  return full
}

export function pathToId(rootDir: string, filePath: string): string {
  const rootResolved = resolve(rootDir)
  const full = resolve(filePath)
  const rel = relative(rootResolved, full)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path "${filePath}" is outside context root`)
  }
  if (!rel.endsWith(".md")) {
    throw new Error(`path "${filePath}" is not a markdown file`)
  }
  // Ids always use forward slashes regardless of platform separator.
  return rel.slice(0, -3).split(sep).join("/")
}
