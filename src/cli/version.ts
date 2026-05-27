import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

let cached: string | undefined

export function packageVersion(): string {
  if (cached) return cached
  // dist/cli/version.js → dist/cli → dist → package root
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "..", "package.json"),
    join(here, "..", "..", "..", "package.json"),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string }
      if (pkg.version) {
        cached = pkg.version
        return cached
      }
    } catch {}
  }
  cached = "0.0.0"
  return cached
}
