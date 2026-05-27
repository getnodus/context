/**
 * Thin compatibility layer that re-exports the agent registry under the
 * names other CLI commands have historically imported. The actual logic
 * lives in `./agents/registry.ts`; this file is what `init`, `uninstall`,
 * and `doctor` import.
 *
 * Keeping a stable surface here means the registry internals can evolve
 * (more install kinds, richer detection) without rippling out to every
 * call site.
 */

import {
  inspectMcpHealth as _inspectMcpHealth,
  installAgent,
  loadAgents,
  mcpCommandLocalNode,
  mcpCommandNpx,
  readMcp as _readMcp,
  resolveAgents,
  uninstallAgent,
  type McpCommand,
  type McpHealth,
  type ResolvedAgent,
} from "./agents/registry.js"

export type AgentTarget = ResolvedAgent

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export function mcpCommand(): McpServerConfig {
  return mcpCommandNpx()
}

export function localMcpCommand(distPath: string): McpServerConfig {
  return mcpCommandLocalNode(distPath)
}

export async function detectTargets(): Promise<AgentTarget[]> {
  return resolveAgents()
}

export async function readMcp(target: AgentTarget): Promise<McpServerConfig | undefined> {
  return _readMcp(target)
}

export interface InstallResult {
  target: AgentTarget
  status: "installed" | "updated" | "already-installed"
}

export async function installMcp(
  target: AgentTarget,
  cmd: McpServerConfig,
): Promise<InstallResult> {
  const result = await installAgent(target, cmd as McpCommand)
  return { target, status: result.status }
}

export async function uninstallMcp(target: AgentTarget): Promise<boolean> {
  return uninstallAgent(target)
}

export { inspectMcpHealth, type McpHealth } from "./agents/registry.js"
export { loadAgents }

/**
 * Whether the agent has a native CLI helper we can shell out to. Only
 * the registry knows the install spec, so callers can use this to choose
 * messaging (e.g. "via claude mcp add").
 */
export function hasNativeInstaller(target: AgentTarget): boolean {
  return target.definition.install.type === "cli-mcp"
}

export async function nativeInstallerAvailable(target: AgentTarget): Promise<boolean> {
  // The registry's writeByInstall already does the right thing — if the
  // CLI is unavailable it transparently falls back to JSON. This helper
  // exists for messaging only; we return true when the install spec
  // *prefers* a native CLI, regardless of whether the binary is on PATH.
  return hasNativeInstaller(target)
}

// Legacy re-exports kept so callers don't break — they all delegate to
// the unified installMcp/uninstallMcp which already does the right thing.
export async function nativeInstall(
  target: AgentTarget,
  cmd: McpServerConfig,
): Promise<{ status: "installed" | "updated" }> {
  const r = await installMcp(target, cmd)
  return { status: r.status === "already-installed" ? "installed" : r.status }
}

export async function nativeUninstall(target: AgentTarget): Promise<boolean> {
  return uninstallMcp(target)
}

// Internal-but-exported helpers kept so tests can call them.
export { _inspectMcpHealth as inspectMcpHealthInternal }
