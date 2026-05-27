import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { readFile, writeFile, mkdir, stat } from "node:fs/promises"

export interface AgentTarget {
  /** Stable id used in CLI flags and messages. */
  id: string
  /** Display name. */
  name: string
  /** Absolute path to the config file. */
  configPath: string
  /** True if the config file (or its parent app dir) currently exists. */
  detected: boolean
}

const MCP_KEY = "nodus-context"

interface McpServerConfig {
  command: string
  args: string[]
}

export function mcpCommand(): McpServerConfig {
  return { command: "npx", args: ["-y", "@nodus/context", "mcp"] }
}

export function localMcpCommand(distPath: string): McpServerConfig {
  return { command: "node", args: [distPath] }
}

export async function detectTargets(): Promise<AgentTarget[]> {
  const home = homedir()
  const os = platform()

  const claudeDesktopPath =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : os === "win32"
        ? join(process.env.APPDATA ?? home, "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json")

  const claudeDesktopParent =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : os === "win32"
        ? join(process.env.APPDATA ?? home, "Claude")
        : join(home, ".config", "Claude")

  const claudeCodePath = join(home, ".claude.json")
  const cursorPath = join(home, ".cursor", "mcp.json")
  const cursorParent = join(home, ".cursor")

  const targets: AgentTarget[] = [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      configPath: claudeDesktopPath,
      detected: await exists(claudeDesktopPath) || await exists(claudeDesktopParent),
    },
    {
      id: "claude-code",
      name: "Claude Code",
      configPath: claudeCodePath,
      detected: await exists(claudeCodePath),
    },
    {
      id: "cursor",
      name: "Cursor",
      configPath: cursorPath,
      detected: await exists(cursorPath) || await exists(cursorParent),
    },
  ]

  return targets
}

export interface InstallResult {
  target: AgentTarget
  status: "installed" | "already-installed" | "updated"
}

export async function installMcp(
  target: AgentTarget,
  serverConfig: McpServerConfig,
): Promise<InstallResult> {
  const config = await readJsonConfig(target.configPath)
  const servers = (config.mcpServers ??= {}) as Record<string, McpServerConfig>
  const existing = servers[MCP_KEY]
  let status: InstallResult["status"]

  if (!existing) {
    status = "installed"
  } else if (sameConfig(existing, serverConfig)) {
    status = "already-installed"
  } else {
    status = "updated"
  }

  servers[MCP_KEY] = serverConfig
  await writeJsonConfig(target.configPath, config)
  return { target, status }
}

export async function uninstallMcp(target: AgentTarget): Promise<boolean> {
  const config = await readJsonConfig(target.configPath)
  const servers = config.mcpServers as Record<string, unknown> | undefined
  if (!servers || !(MCP_KEY in servers)) return false
  delete servers[MCP_KEY]
  await writeJsonConfig(target.configPath, config)
  return true
}

export async function readMcp(target: AgentTarget): Promise<McpServerConfig | undefined> {
  const config = await readJsonConfig(target.configPath)
  const servers = config.mcpServers as Record<string, McpServerConfig> | undefined
  return servers?.[MCP_KEY]
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readJsonConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8")
    if (!raw.trim()) return {}
    return JSON.parse(raw)
  } catch (e: any) {
    if (e.code === "ENOENT") return {}
    throw new Error(`Could not read ${path}: ${e.message}`)
  }
}

async function writeJsonConfig(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8")
}

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  if (a.command !== b.command) return false
  if (a.args.length !== b.args.length) return false
  return a.args.every((v, i) => v === b.args[i])
}
