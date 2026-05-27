import { bold, cyan, dim, fail, green, info, yellow } from "../output.js"
import { loadAgents, resolveAgents } from "../agents/registry.js"
import type { AgentDefinition } from "../agents/types.js"
import { loadConfig, saveConfig } from "../../config/index.js"
import { confirm } from "../prompt.js"

export interface AgentsListArgs {
  json?: boolean
}

export async function cmdAgentsList(args: AgentsListArgs): Promise<void> {
  const resolved = await resolveAgents()
  if (args.json) {
    process.stdout.write(JSON.stringify(resolved, null, 2) + "\n")
    return
  }
  info(bold("known agents"))
  const idWidth = Math.max(...resolved.map((a) => a.id.length), 8)
  for (const a of resolved) {
    const marker = a.detected ? green("●") : dim("○")
    const tag = a.source === "custom" ? cyan("custom  ") : dim("built-in")
    const installKind = a.definition.install.type
    info(
      `  ${marker} ${a.id.padEnd(idWidth)}  ${tag}  ${dim(installKind.padEnd(15))}  ${a.name}`,
    )
    info(`    ${dim(a.configPath)}`)
    if (a.definition.notes) info(`    ${dim(a.definition.notes)}`)
  }
  info("")
  info(dim("● = app installed, ○ = not detected"))
  info(dim("add custom agents with: nodus-context agents add <id> --name=... --json-path=... [--detect-app=Name] [--detect-cmd=name] [--key=mcpServers]"))
}

export interface AgentsAddArgs {
  id: string
  name?: string
  jsonPath?: string
  key?: string[]
  detectApp?: string
  detectCommand?: string
  detectPath?: string
  detectAlways?: boolean
  notes?: string
  force?: boolean
}

export async function cmdAgentsAdd(args: AgentsAddArgs): Promise<void> {
  if (!args.jsonPath) {
    fail("agents add: --json-path <file> is required (the agent's MCP config file)")
  }
  const detect: AgentDefinition["detect"] = []
  if (args.detectApp) detect.push({ type: "app-bundle", mac: args.detectApp, linux: args.detectApp.toLowerCase() })
  if (args.detectCommand) detect.push({ type: "command", name: args.detectCommand })
  if (args.detectPath) detect.push({ type: "path-exists", path: args.detectPath })
  if (args.detectAlways || detect.length === 0) detect.push({ type: "always" })

  const def: AgentDefinition = {
    id: args.id,
    name: args.name ?? args.id,
    configPathHint: args.jsonPath!,
    detect: detect.length === 1 ? detect[0] : detect,
    install: {
      type: "json-merge",
      path: args.jsonPath!,
      ...(args.key && args.key.length > 0 ? { keyPath: args.key } : {}),
    },
    ...(args.notes ? { notes: args.notes } : {}),
  }

  const config = await loadConfig()
  const existing = (config.customAgents ?? []).find((a) => a.id === args.id)
  if (existing && !args.force) {
    const ok = await confirm(`agent "${args.id}" already exists. overwrite?`, false)
    if (!ok) {
      info("aborted")
      return
    }
  }
  const remaining = (config.customAgents ?? []).filter((a) => a.id !== args.id)
  remaining.push(def)
  config.customAgents = remaining
  await saveConfig(config)
  info(`${green("added")} custom agent ${cyan(args.id)} ${dim(`(${def.install.type})`)}`)
}

export async function cmdAgentsRemove(args: { id: string }): Promise<void> {
  const config = await loadConfig()
  const before = config.customAgents ?? []
  const after = before.filter((a) => a.id !== args.id)
  if (after.length === before.length) {
    fail(`no custom agent "${args.id}" (built-ins can't be removed; override with the same id instead)`)
  }
  config.customAgents = after.length > 0 ? after : undefined
  await saveConfig(config)
  info(`${green("removed")} custom agent ${cyan(args.id)}`)
}

/** Used by `init`/`uninstall` to honour --only and to surface unknown ids. */
export async function resolveByIds(ids: string[]): Promise<{
  known: string[]
  unknown: string[]
}> {
  const all = await loadAgents()
  const knownIds = new Set(all.map((a) => a.definition.id))
  const known: string[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (knownIds.has(id)) known.push(id)
    else unknown.push(id)
  }
  return { known, unknown }
}
