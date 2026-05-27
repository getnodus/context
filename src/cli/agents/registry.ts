import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { readFile, writeFile, mkdir, stat } from "node:fs/promises"
import { spawn } from "node:child_process"
import { loadConfig } from "../../config/index.js"
import { builtInAgents } from "./built-in.js"
import {
  AgentDefinition,
  DetectRule,
  InstallSpec,
  InstallJsonMerge,
  InstallCliMcp,
} from "./types.js"

export const MCP_KEY = "nodus-context"

export interface McpCommand {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface AgentRecord {
  definition: AgentDefinition
  /** Where this agent came from — surfaced in `agents list`. */
  source: "built-in" | "custom"
}

export interface ResolvedAgent {
  id: string
  name: string
  /** Resolved file path our MCP entry lives in (or would live in). */
  configPath: string
  /** True if the agent's application is currently installed on this machine. */
  detected: boolean
  source: "built-in" | "custom"
  definition: AgentDefinition
}

/**
 * Load all known agents: built-ins from code + custom from
 * `~/.nodus/config.json`. Custom agents may shadow a built-in by re-using
 * its id (useful for overriding a config path).
 */
export async function loadAgents(): Promise<AgentRecord[]> {
  const built = builtInAgents().map<AgentRecord>((definition) => ({
    definition,
    source: "built-in",
  }))
  let custom: AgentDefinition[] = []
  try {
    const config = await loadConfig()
    custom = (config.customAgents ?? []) as AgentDefinition[]
  } catch {
    // If the config is malformed, surface that via doctor — agent listing
    // should still work with built-ins only.
  }
  // Custom overrides built-in by id.
  const byId = new Map<string, AgentRecord>()
  for (const r of built) byId.set(r.definition.id, r)
  for (const def of custom) byId.set(def.id, { definition: def, source: "custom" })
  return Array.from(byId.values())
}

export async function resolveAgents(): Promise<ResolvedAgent[]> {
  const records = await loadAgents()
  return Promise.all(records.map(resolveAgent))
}

export async function resolveAgent(record: AgentRecord): Promise<ResolvedAgent> {
  const def = record.definition
  return {
    id: def.id,
    name: def.name,
    configPath: configPathFor(def.install) ?? def.configPathHint,
    detected: await runDetect(def.detect),
    source: record.source,
    definition: def,
  }
}

// --------------------------- detection ---------------------------

async function runDetect(rule: DetectRule | DetectRule[]): Promise<boolean> {
  const rules = Array.isArray(rule) ? rule : [rule]
  for (const r of rules) {
    if (await runSingleDetect(r)) return true
  }
  return false
}

async function runSingleDetect(rule: DetectRule): Promise<boolean> {
  const os = platform()
  switch (rule.type) {
    case "always":
      return true
    case "command":
      return commandOnPath(rule.name)
    case "path-exists":
      return exists(expand(rule.path))
    case "app-bundle": {
      const home = homedir()
      if (os === "darwin" && rule.mac) {
        return (
          (await exists(`/Applications/${rule.mac}.app`)) ||
          (await exists(join(home, "Applications", `${rule.mac}.app`)))
        )
      }
      if (os === "win32" && rule.win) {
        const bases = [
          process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
          process.env.PROGRAMFILES,
          process.env["PROGRAMFILES(X86)"],
        ].filter((b): b is string => !!b)
        for (const base of bases) {
          if (await exists(join(base, rule.win))) return true
        }
        return false
      }
      if (rule.linux) {
        if (await commandOnPath(rule.linux)) return true
        const candidates = [
          `/usr/share/applications/${rule.linux}.desktop`,
          `/usr/local/share/applications/${rule.linux}.desktop`,
          join(home, ".local", "share", "applications", `${rule.linux}.desktop`),
        ]
        for (const c of candidates) {
          if (await exists(c)) return true
        }
      }
      return false
    }
  }
}

// --------------------------- install / read / remove ---------------------------

export interface InstallResult {
  status: "installed" | "updated" | "already-installed"
}

export async function readMcp(
  agent: ResolvedAgent,
): Promise<McpCommand | undefined> {
  return readByInstall(agent.definition.install)
}

async function readByInstall(spec: InstallSpec): Promise<McpCommand | undefined> {
  switch (spec.type) {
    case "json-merge":
      return readJsonMerge(spec)
    case "cli-mcp":
      return readCliMcp(spec)
  }
}

export async function installAgent(
  agent: ResolvedAgent,
  cmd: McpCommand,
): Promise<InstallResult> {
  return writeByInstall(agent.definition.install, cmd)
}

async function writeByInstall(
  spec: InstallSpec,
  cmd: McpCommand,
): Promise<InstallResult> {
  switch (spec.type) {
    case "json-merge":
      return writeJsonMerge(spec, cmd)
    case "cli-mcp":
      return writeCliMcp(spec, cmd)
  }
}

export async function uninstallAgent(agent: ResolvedAgent): Promise<boolean> {
  return removeByInstall(agent.definition.install)
}

async function removeByInstall(spec: InstallSpec): Promise<boolean> {
  switch (spec.type) {
    case "json-merge":
      return removeJsonMerge(spec)
    case "cli-mcp":
      return removeCliMcp(spec)
  }
}

function configPathFor(spec: InstallSpec): string | undefined {
  if (spec.type === "json-merge") return expand(spec.path)
  return undefined
}

// --------------------------- json-merge implementation ---------------------------

async function readJsonMerge(spec: InstallJsonMerge): Promise<McpCommand | undefined> {
  const data = await readJsonConfig(expand(spec.path))
  const node = navigate(data, spec.keyPath ?? ["mcpServers"], false)
  if (!node || typeof node !== "object") return undefined
  const entry = (node as Record<string, McpCommand>)[MCP_KEY]
  return entry
}

async function writeJsonMerge(
  spec: InstallJsonMerge,
  cmd: McpCommand,
): Promise<InstallResult> {
  const path = expand(spec.path)
  const data = await readJsonConfig(path)
  const node = navigate(data, spec.keyPath ?? ["mcpServers"], true) as Record<
    string,
    McpCommand
  >
  const existing = node[MCP_KEY]
  let status: InstallResult["status"]
  if (!existing) status = "installed"
  else if (sameCommand(existing, cmd)) status = "already-installed"
  else status = "updated"
  node[MCP_KEY] = cmd
  await writeJsonConfig(path, data)
  return { status }
}

async function removeJsonMerge(spec: InstallJsonMerge): Promise<boolean> {
  const path = expand(spec.path)
  const data = await readJsonConfig(path)
  const node = navigate(data, spec.keyPath ?? ["mcpServers"], false)
  if (!node || typeof node !== "object") return false
  const map = node as Record<string, unknown>
  if (!(MCP_KEY in map)) return false
  delete map[MCP_KEY]
  await writeJsonConfig(path, data)
  return true
}

// --------------------------- generic cli-mcp implementation ---------------------------
//
// Handles agents that expose `<binary> mcp add/remove` — currently Claude
// Code (`claude`) and Codex CLI (`codex`). Each uses the same subcommand
// shape; `scopeFlags` is the only per-agent variation.

async function readCliMcp(spec: InstallCliMcp): Promise<McpCommand | undefined> {
  // We don't shell out to `<binary> mcp get` here — its output format is
  // agent-specific and tends to drift. Both Claude and Codex persist their
  // server entries in a JSON/TOML config that we can also read by other
  // means; for the "is it installed?" check the json fallback path
  // covers Claude. For Codex (TOML) we'd need a TOML reader — for v1 we
  // simply return undefined and let the user trust `<binary> mcp list`.
  if (spec.jsonFallbackPath) {
    const data = await readJsonConfig(expand(spec.jsonFallbackPath))
    const node = navigate(data, ["mcpServers"], false) as
      | Record<string, McpCommand>
      | undefined
    if (node?.[MCP_KEY]) return node[MCP_KEY]
  }
  return undefined
}

async function writeCliMcp(
  spec: InstallCliMcp,
  cmd: McpCommand,
): Promise<InstallResult> {
  if (!(await commandOnPath(spec.binary))) {
    if (spec.jsonFallbackPath) {
      return writeJsonMerge({ type: "json-merge", path: expand(spec.jsonFallbackPath) }, cmd)
    }
    throw new Error(`${spec.binary} not on PATH and no JSON fallback configured`)
  }
  const flags = spec.scopeFlags ?? []
  // Remove first so the new args fully replace the old; ignore failure
  // (most CLIs exit non-zero when nothing was registered).
  await runQuiet(spec.binary, ["mcp", "remove", ...flags, MCP_KEY])
  const args = ["mcp", "add", ...flags, MCP_KEY, "--", cmd.command, ...cmd.args]
  const result = await runQuiet(spec.binary, args)
  if (result.code !== 0) {
    throw new Error(
      `${spec.binary} mcp add exited ${result.code}: ${result.stderr.trim() || "no stderr"}`,
    )
  }
  return { status: "installed" }
}

async function removeCliMcp(spec: InstallCliMcp): Promise<boolean> {
  let removed = false
  if (await commandOnPath(spec.binary)) {
    const flags = spec.scopeFlags ?? []
    const r = await runQuiet(spec.binary, ["mcp", "remove", ...flags, MCP_KEY])
    if (r.code === 0) removed = true
  }
  // Also sweep the JSON fallback location so we don't leave a legacy
  // direct-JSON registration behind.
  if (spec.jsonFallbackPath) {
    removed =
      (await removeJsonMerge({ type: "json-merge", path: expand(spec.jsonFallbackPath) })) ||
      removed
  }
  return removed
}

// --------------------------- health inspection ---------------------------

export interface McpHealth {
  kind: "npx" | "node-file" | "other"
  filePath?: string
  fileExists: boolean
}

export async function inspectMcpHealth(cmd: McpCommand): Promise<McpHealth> {
  if (cmd.command === "npx") return { kind: "npx", fileExists: true }
  if (cmd.command === "node" && cmd.args.length > 0) {
    const filePath = cmd.args.find((a) => !a.startsWith("-"))
    if (!filePath) return { kind: "other", fileExists: true }
    return { kind: "node-file", filePath, fileExists: await exists(filePath) }
  }
  return { kind: "other", fileExists: true }
}

// --------------------------- canonical MCP commands ---------------------------

export function mcpCommandNpx(): McpCommand {
  return {
    command: "npx",
    args: ["-y", "--package", "@getnodus/context", "nodus-context-mcp"],
  }
}

export function mcpCommandLocalNode(distPath: string): McpCommand {
  return { command: "node", args: [distPath] }
}

// --------------------------- helpers ---------------------------

function expand(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function commandOnPath(name: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? ""
  const sep = process.platform === "win32" ? ";" : ":"
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""]
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        const s = await stat(join(dir, name + ext))
        if (s.isFile()) return true
      } catch {}
    }
  }
  return false
}

async function readJsonConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e: any) {
    if (e.code === "ENOENT") return {}
    throw new Error(`could not read ${path}: ${e.message}`)
  }
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (strictErr) {
    // Some agents (Zed, VS Code, JetBrains) ship JSONC: line/block
    // comments and trailing commas. Tolerate that on read so we don't
    // blow up on a hand-edited settings file. We re-emit canonical JSON
    // on write, which strips comments — the user is warned about that
    // by the `notes` field on those agents' definitions.
    try {
      return JSON.parse(stripJsonc(raw))
    } catch {
      throw new Error(
        `could not parse ${path}: ${(strictErr as Error).message}. ` +
          `If this file uses comments or trailing commas, fix the syntax error first.`,
      )
    }
  }
}

/**
 * Remove `//` line comments, `/* … *\/` block comments, and trailing
 * commas before `]` / `}`. String contents are preserved verbatim — we
 * walk character-by-character with a string-state flag so a `//` inside
 * a JSON string survives.
 */
function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  let inString = false
  let stringQuote = '"'
  while (i < n) {
    const c = input[i]
    if (inString) {
      out += c
      if (c === "\\" && i + 1 < n) {
        out += input[i + 1]
        i += 2
        continue
      }
      if (c === stringQuote) inString = false
      i++
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      stringQuote = c
      out += c
      i++
      continue
    }
    if (c === "/" && i + 1 < n && input[i + 1] === "/") {
      // Line comment — skip to newline.
      i += 2
      while (i < n && input[i] !== "\n") i++
      continue
    }
    if (c === "/" && i + 1 < n && input[i + 1] === "*") {
      // Block comment — skip to */.
      i += 2
      while (i + 1 < n && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (c === ",") {
      // Trailing comma — lookahead past whitespace for ] or }.
      let j = i + 1
      while (j < n && /\s/.test(input[j])) j++
      if (j < n && (input[j] === "]" || input[j] === "}")) {
        // Drop the comma.
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

async function writeJsonConfig(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8")
}

function navigate(
  root: Record<string, unknown>,
  keys: string[],
  create: boolean,
): Record<string, unknown> | undefined {
  let node: Record<string, unknown> = root
  for (const k of keys) {
    const next = node[k]
    if (next && typeof next === "object" && !Array.isArray(next)) {
      node = next as Record<string, unknown>
    } else if (create) {
      const fresh: Record<string, unknown> = {}
      node[k] = fresh
      node = fresh
    } else {
      return undefined
    }
  }
  return node
}

function sameCommand(a: McpCommand, b: McpCommand): boolean {
  if (a.command !== b.command) return false
  if (a.args.length !== b.args.length) return false
  if (!a.args.every((v, i) => v === b.args[i])) return false
  // env shape comparison — order independent
  const ae = a.env ?? {}
  const be = b.env ?? {}
  const aKeys = Object.keys(ae).sort()
  const bKeys = Object.keys(be).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false
    if (ae[aKeys[i]] !== be[bKeys[i]]) return false
  }
  return true
}

async function runQuiet(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (b) => (stdout += b.toString()))
    proc.stderr?.on("data", (b) => (stderr += b.toString()))
    proc.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + (e.message ?? "") }))
    proc.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
