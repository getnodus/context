import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import {
  AgentTarget,
  detectTargets,
  inspectMcpHealth,
  installMcp,
  localMcpCommand,
  mcpCommand,
  readMcp,
} from "../integrations.js"
import { confirm } from "../prompt.js"
import { bold, cyan, dim, green, info, printRestartHint, red, yellow } from "../output.js"
import { getDefaultLocalDir } from "../../backends/index.js"
import { runWizard } from "../wizard/index.js"

export interface InitOptions {
  yes?: boolean
  only?: string[]
  local?: boolean
  dryRun?: boolean
  repair?: boolean
  /** Explicitly force the wizard (default when no other flags are set). */
  wizard?: boolean
  /** Explicitly opt out of the wizard (alias for legacy behavior). */
  noWizard?: boolean
}

export async function runInit(opts: InitOptions): Promise<void> {
  if (opts.repair) return runRepair(opts)
  // Wizard fires when: stdin is a TTY AND no non-wizard flags are set AND
  // the user didn't explicitly opt out. Power users (--yes, --only,
  // --local, --dry-run, --no-wizard) get the legacy non-interactive path.
  const shouldWizard =
    opts.wizard ||
    (process.stdin.isTTY &&
      !opts.yes &&
      !opts.only?.length &&
      !opts.local &&
      !opts.dryRun &&
      !opts.noWizard)
  if (shouldWizard) return runWizard({ yes: opts.yes })
  // Non-TTY (pipe/CI) → auto-assume --yes so the legacy path never hangs
  // on a confirm() it can't answer.
  const effective = process.stdin.isTTY ? opts : { ...opts, yes: opts.yes ?? true }
  return runFreshInstall(effective)
}

async function runFreshInstall(opts: InitOptions): Promise<void> {
  info(bold("context setup"))
  info(dim("Default local storage: ") + cyan(getDefaultLocalDir()))
  if (opts.dryRun) info(yellow("dry-run: no changes will be written"))
  info("")

  const all = await detectTargets()
  const filter = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined
  const targets = filter ? all.filter((t) => filter.has(t.id)) : all

  if (targets.length === 0) {
    info(yellow("no matching agents to configure"))
    return
  }

  info("Detected agents:")
  for (const t of all) {
    const mark = t.detected ? green("●") : dim("○")
    info(`  ${mark} ${t.name}  ${dim(t.configPath)}`)
  }
  info("")

  const candidates = targets.filter((t) => t.detected || filter?.has(t.id))
  if (candidates.length === 0) {
    info(yellow("no agents detected — install Claude Desktop, Claude Code, or Cursor first"))
    info(dim("or pass --only=<id> to force-write a config"))
    return
  }

  const cmd = opts.local ? localMcpCommand(resolveLocalServerPath()) : mcpCommand()
  info(`MCP command: ${cyan(cmd.command + " " + cmd.args.join(" "))}`)
  info("")

  const names = candidates.map((t) => t.name).join(", ")
  if (!opts.yes && !opts.dryRun) {
    const ok = await confirm(`Add context MCP server to: ${names}?`, true)
    if (!ok) {
      info("aborted")
      return
    }
  }

  for (const t of candidates) {
    if (opts.dryRun) {
      info(`  ${yellow("would install")}  ${t.name}  ${dim(t.configPath)}`)
      continue
    }
    await installOne(t, cmd)
  }

  printRestartHint()
}

async function runRepair(opts: InitOptions): Promise<void> {
  info(bold("context repair"))
  if (opts.dryRun) info(yellow("dry-run: no changes will be written"))
  info("")

  const all = await detectTargets()
  const filter = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined
  const targets = filter ? all.filter((t) => filter.has(t.id)) : all

  // Always repair to the portable `npx` form — that's the whole point of
  // repair (the previous install probably baked an absolute path that's
  // since gone away).
  const cmd = mcpCommand()
  const broken: AgentTarget[] = []

  for (const t of targets) {
    let existing
    try {
      existing = await readMcp(t)
    } catch (e) {
      info(`  ${red("error    ")} ${t.name}: ${(e as Error).message}`)
      continue
    }
    if (!existing) {
      info(`  ${dim("skip     ")} ${t.name}  ${dim("(not configured)")}`)
      continue
    }
    const health = await inspectMcpHealth(existing)
    if (health.kind !== "node-file" || health.fileExists) {
      info(`  ${green("ok       ")} ${t.name}  ${dim(`(${existing.command} ${existing.args.join(" ")})`)}`)
      continue
    }
    broken.push(t)
    info(
      `  ${yellow("broken   ")} ${t.name}  ${dim("→ ")}${red(health.filePath ?? "?")}`,
    )
  }

  if (broken.length === 0) {
    info("")
    info(green("nothing to repair."))
    return
  }

  info("")
  info(`will rewrite ${broken.length} install(s) to: ${cyan(cmd.command + " " + cmd.args.join(" "))}`)

  if (!opts.yes && !opts.dryRun) {
    const ok = await confirm("proceed?", true)
    if (!ok) {
      info("aborted")
      return
    }
  }

  for (const t of broken) {
    if (opts.dryRun) {
      info(`  ${yellow("would repair")} ${t.name}`)
      continue
    }
    await installOne(t, cmd)
  }

  printRestartHint()
}

async function installOne(
  target: AgentTarget,
  cmd: { command: string; args: string[] },
): Promise<void> {
  // The registry dispatches on the agent's install spec — for Claude Code
  // it shells out to `claude mcp add`; for everything else it writes the
  // appropriate JSON file under the right key path. Failure messaging is
  // unified here.
  try {
    const result = await installMcp(target, cmd)
    const via =
      target.definition.install.type === "cli-mcp"
        ? dim(` (via ${target.definition.install.binary} mcp add)`)
        : ""
    const tag =
      result.status === "installed"
        ? green("installed")
        : result.status === "updated"
          ? yellow("updated  ")
          : dim("already   ")
    info(`  ${tag} ${target.name}${via}`)
  } catch (e) {
    info(`  ${red("failed   ")} ${target.name}: ${(e as Error).message}`)
  }
}

function resolveLocalServerPath(): string {
  // src/cli/commands/init.ts → dist/cli/commands/init.js at runtime.
  // The MCP server lives at dist/mcp/server.js.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..", "..", "mcp", "server.js")
}
