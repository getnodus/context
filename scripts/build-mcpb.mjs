#!/usr/bin/env node
/**
 * Build a Claude Desktop `.mcpb` bundle for @getnodus/context.
 *
 * Why: Claude Desktop renders a per-server icon today only when the server
 * is installed via an MCPB ("Desktop Extension") bundle. Plain
 * `mcpServers` entries in `claude_desktop_config.json` show a generic
 * placeholder regardless of `serverInfo.icons`. So we ship a bundle whose
 * `manifest.json` references our avatar; the server command inside still
 * delegates to `npx @getnodus/context` so behavior matches a normal npm
 * install.
 *
 * Output: `dist/nodus-context-<version>.mcpb` — upload to GitHub Releases.
 */
import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))

const stageDir = join(root, "dist", "mcpb-stage")
await rm(stageDir, { recursive: true, force: true })
await mkdir(stageDir, { recursive: true })

const manifest = {
  manifest_version: "0.3",
  name: "nodus-context",
  display_name: "Nodus Context",
  version: pkg.version,
  description: pkg.description,
  long_description:
    "Personal context layer for AI agents. Stores user identity, preferences, " +
    "and project state so every agent picks up where the last one left off. " +
    "Exposes read_context / write_context / search_context / list_context / " +
    "list_tags / delete_context as MCP tools, plus a nodus-context://brief " +
    "resource auto-loaded at session start. Storage is pluggable: local " +
    "markdown files by default, or any HTTP backend speaking the Nodus " +
    "Context Protocol.",
  author: { name: "Nodus", url: "https://github.com/getnodus" },
  repository: { type: "git", url: "https://github.com/getnodus/context" },
  homepage: "https://github.com/getnodus/context",
  license: "MIT",
  keywords: ["context", "memory", "personal", "mcp", "nodus"],
  icon: "icon.png",
  server: {
    type: "binary",
    entry_point: "npx",
    mcp_config: {
      command: "npx",
      args: ["-y", "--package", "@getnodus/context", "nodus-context-mcp"],
      env: {},
    },
  },
  compatibility: { claude_desktop: ">=0.10.0" },
}

await writeFile(
  join(stageDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
)
await copyFile(
  join(root, "assets", "avatar-1024.png"),
  join(stageDir, "icon.png"),
)

const out = join(root, "dist", `nodus-context-${pkg.version}.mcpb`)
await rm(out, { force: true })

// Pinned so release output is reproducible — unpinned `npx -y mcpb` would
// silently pull whatever's latest at release time and could break the format.
const MCPB_VERSION = "2.1.2"

await new Promise((resolve, reject) => {
  const proc = spawn(
    "npx",
    ["-y", `@anthropic-ai/mcpb@${MCPB_VERSION}`, "pack", stageDir, out],
    { stdio: "inherit", cwd: root },
  )
  proc.on("error", reject)
  proc.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`mcpb pack exited ${code}`)),
  )
})

await rm(stageDir, { recursive: true, force: true })
console.log(`\nbuilt ${out}`)
