#!/usr/bin/env node
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { runInit } from "./commands/init.js"
import { runUninstall } from "./commands/uninstall.js"
import {
  cmdAdd,
  cmdDelete,
  cmdEdit,
  cmdList,
  cmdSearch,
  cmdShow,
} from "./commands/crud.js"
import { cmdAccept } from "./commands/accept.js"
import { cmdMerge } from "./commands/merge.js"
import { cmdDoctor, cmdPath } from "./commands/doctor.js"
import { cmdHistory, cmdRevert, cmdShowSnapshot } from "./commands/history.js"
import { cmdExport, cmdImport } from "./commands/portable.js"
import { cmdTags } from "./commands/tags.js"
import { cmdStale } from "./commands/stale.js"
import { cmdVerify } from "./commands/verify.js"
import {
  cmdConfigPath,
  cmdConfigShow,
  cmdProfileAdd,
  cmdProfileList,
  cmdProfileRemove,
  cmdUse,
} from "./commands/profile.js"
import { cmdSync } from "./commands/sync.js"
import { cmdAgentsAdd, cmdAgentsList, cmdAgentsRemove } from "./commands/agents.js"
import { cmdJoin } from "./commands/join.js"
import { cmdSetup } from "./commands/setup.js"
import { cmdCapabilities } from "./commands/capabilities.js"
import { bold, cyan, dim, fail, info } from "./output.js"
import { packageVersion } from "./version.js"

/**
 * Display the command name as the user actually invoked it. Both `context`
 * (preferred) and `nodus-context` (legacy) symlink to this script — using
 * `argv[1]` keeps the in-help examples consistent with what they typed,
 * which matters for copy-paste.
 */
function invokedAs(): string {
  const argv1 = process.argv[1]
  if (!argv1) return "context"
  const name = basename(argv1)
  return name === "nodus-context" ? "nodus-context" : "context"
}

function usage(): string {
  const cmd = invokedAs()
  return `${bold(cmd)} — personal context layer for AI agents

${bold("Usage:")}
  ${cyan(cmd)} <command> [args]

${bold("Setup:")}
  init                             Interactive setup wizard
                                   (asks where context lives + which agents to install)
  setup --backend=local|server|mirror [--url=<u>] [--token=<t>]
        [--agents=detected|all|none|<a,b>] [--profile=<name>] [--json]
                                   Non-interactive AI-friendly setup (single deterministic command).
                                   With --json, exits non-zero on partial agent-install failure.
  join <pairing-string>            One-shot: paste nodus://… string, configure profile + install MCPs
  uninstall [--yes] [--dry-run] [--only=<id>]
                                   Remove the MCP server from detected agents
  doctor [--json] [--memory]       Show config + integration status. --json includes memory health
                                   so one call gives an AI agent the full picture; --memory is the
                                   human-readable deep audit
  capabilities [--json]            Print supported features for AI orientation

${bold("Agents:")}
  agents list [--json]             List built-in + custom agents and detection
  agents add <id> --json-path=<file> [--name=<n>] [--key=mcpServers]
                                 [--detect-app=<Name>] [--detect-cmd=<bin>]
                                 [--detect-path=<file>] [--detect-always]
                                 [--notes=<text>] [-f]
                                   Register a custom agent (saved to config)
  agents rm <id>                   Remove a custom agent

${bold("Profiles:")}
  use <name>                       Switch active profile
  profile list                     List profiles
  profile add <name> --type=<t> [--url=<u> --token=<t> --path=<p> --options=<json>] [--use]
                                   Add a profile (type: local | http | module | mirror)
                                   mirror: local primary + http secondary (--url required)
  profile rm <name>                Remove a profile
  config show                      Print the full config
  config path                      Print path to config file

${bold("Entries:")}
  list [--prefix=X] [--tag=T] [--type=T]
                                   List entries
  show <id>                        Print one entry
  add <id> [--type=T] [--title=T] [--tag=T] [--supersedes=ID] [--expires=ISO]
          [--verify=kind:target]
                                   Create/update an entry (stdin or $EDITOR).
                                   --verify attaches a reality check: url:https://…,
                                   repo:owner/name, or path:/local/file
  edit <id> [--verify=kind:target] [--clear-verify]
                                   Open in $EDITOR — or, when --verify is passed alone,
                                   attach/replace the verify block without opening the editor
  search <query>                   Search (BM25 lexical; semantic when embedder configured)
  delete <id>                      Delete an entry
  tags                             List all tags in use
  stale [--days=90]                Show stale and expired entries

${bold("Memory hygiene:")}
  verify <id>                      Run an entry's verify block once
  verify --all                     Re-check every entry with a verify block
  verify --failed                  Re-check only currently failed entries
  verify --never                   Check entries that have a verify but never ran
  verify --stale                   Re-check entries verified >30 days ago
  accept <id> [--reason="..."]     Mark a failed verify as expected (e.g. "repo is intentionally
                                   archived"). Suppresses it from health surfaces until a
                                   passing verify auto-clears, or you run --unaccept
  accept --unaccept <id>           Reverse a prior accept
  merge <from> <into> [--body=...] Combine two entries: appends from's body to into's, links via
                                   supersedes, deletes from. Pipe stdin or pass --body to provide
                                   a hand-consolidated body

${bold("History:")}
  history <id>                     List prior versions
  revert <id> [--at=<file>]        Restore a prior version
  snapshot <id> --at=<file>        Print a snapshot body

${bold("Portability:")}
  export [--out=<file>]            Export all entries to JSON
  import <file> [--overwrite]      Import entries from a bundle
  sync push|pull <other-profile> [--overwrite] [--dry-run] [-y]
  sync push|pull --from=<p> --to=<p> [--overwrite] [--dry-run] [-y]
                                   Copy entries between profiles
                                   (push: active→other; pull: other→active)

${bold("Other:")}
  path [<id>]                      Print disk path of root or an entry
  mcp                              Run the MCP server on stdio (used by agents)
  help                             Show this help
  version                          Print the installed version

${dim("Storage: ~/.nodus/context/  (override with NODUS_CONTEXT_DIR)")}
${dim("Config:  ~/.nodus/config.json (override with NODUS_CONFIG_DIR)")}
${dim("Verify:  set NODUS_VERIFY_TIMEOUT_MS to change timeout; NODUS_DISABLE_BACKGROUND_VERIFY=1 to opt out")}
${dim("Add --json to list/show/search/tags/history/profile-list/accept/merge/verify for JSON output.")}
`
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage())
    return
  }

  switch (cmd) {
    case "init":
      return runInit(parseInit(rest))
    case "uninstall":
      return runUninstall(parseUninstall(rest))
    case "doctor":
      return cmdDoctor(parseDoctor(rest))
    case "use":
      return cmdUse(parseUse(rest))
    case "profile": {
      const [sub, ...subRest] = rest
      switch (sub) {
        case "list":
        case undefined:
          return cmdProfileList(parseProfileList(subRest))
        case "add":
          return cmdProfileAdd(parseProfileAdd(subRest))
        case "rm":
        case "remove":
        case "delete":
          return cmdProfileRemove(parseProfileRemove(subRest))
        default:
          fail(`unknown 'profile' subcommand: ${sub}`)
      }
    }
    case "config": {
      const [sub, ...subRest] = rest
      switch (sub) {
        case undefined:
        case "show":
          return cmdConfigShow(parseConfigShow(subRest))
        case "path":
          return cmdConfigPath()
        default:
          fail(`unknown 'config' subcommand: ${sub}`)
      }
    }
    case "list":
      return cmdList(parseList(rest))
    case "show":
      return cmdShow(parseShow(rest))
    case "add":
      return cmdAdd(parseAdd(rest))
    case "edit":
      return cmdEdit(parseEdit(rest))
    case "accept":
      return cmdAccept(parseAccept(rest))
    case "merge":
      return cmdMerge(parseMerge(rest))
    case "search":
      return cmdSearch(parseSearch(rest))
    case "delete":
    case "rm":
      return cmdDelete(parseSingleId(rest, "delete"))
    case "tags":
      return cmdTags(parseTags(rest))
    case "stale":
      return cmdStale(parseStale(rest))
    case "verify":
      return cmdVerify(parseVerify(rest))
    case "history":
      return cmdHistory(parseHistory(rest))
    case "revert":
      return cmdRevert(parseRevert(rest))
    case "snapshot":
      return cmdShowSnapshot(parseSnapshot(rest))
    case "export":
      return cmdExport(parseExport(rest))
    case "import":
      return cmdImport(parseImport(rest))
    case "sync":
      return cmdSync(parseSync(rest))
    case "join":
      return cmdJoin(parseJoin(rest))
    case "setup":
      return cmdSetup(parseSetup(rest))
    case "capabilities":
      return cmdCapabilities(parseCapabilities(rest))
    case "agents": {
      const [sub, ...subRest] = rest
      switch (sub) {
        case undefined:
        case "list":
        case "ls":
          return cmdAgentsList(parseAgentsList(subRest))
        case "add":
          return cmdAgentsAdd(parseAgentsAdd(subRest))
        case "rm":
        case "remove":
        case "delete":
          return cmdAgentsRemove(parseAgentsRemove(subRest))
        default:
          fail(`unknown 'agents' subcommand: ${sub}`)
      }
    }
    case "path":
      return cmdPath(rest[0])
    case "mcp":
      await import("../mcp/server.js")
      return
    case "version":
    case "--version":
    case "-v":
      info(packageVersion())
      return
    default:
      fail(`unknown command: ${cmd}\n\nrun '${bold(`${invokedAs()} help`)}' for usage`)
  }
}

function parseInit(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y" },
      only: { type: "string", multiple: true },
      local: { type: "boolean" },
      repair: { type: "boolean" },
      wizard: { type: "boolean" },
      "no-wizard": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  })
  return {
    yes: parsed.values.yes,
    only: parsed.values.only,
    local: parsed.values.local,
    repair: parsed.values.repair,
    wizard: parsed.values.wizard,
    noWizard: parsed.values["no-wizard"],
    dryRun: parsed.values["dry-run"],
  }
}

function parseUninstall(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y" },
      only: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  })
  return {
    yes: parsed.values.yes,
    only: parsed.values.only,
    dryRun: parsed.values["dry-run"],
  }
}

function parseUse(args: string[]) {
  const parsed = parseArgs({ args, options: {}, allowPositionals: true })
  const name = parsed.positionals[0]
  if (!name) fail("use: missing <name>")
  return { name }
}

function parseProfileList(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  return { json: parsed.values.json }
}

function parseProfileAdd(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      type: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      "root-dir": { type: "string" },
      path: { type: "string" },
      options: { type: "string" },
      use: { type: "boolean" },
    },
    allowPositionals: true,
  })
  const name = parsed.positionals[0]
  if (!name) fail("profile add: missing <name>")
  const type = parsed.values.type
  if (!type) fail("profile add: missing --type")
  return {
    name,
    type: type!,
    url: parsed.values.url,
    token: parsed.values.token,
    rootDir: parsed.values["root-dir"],
    path: parsed.values.path,
    options: parsed.values.options,
    use: parsed.values.use,
  }
}

function parseProfileRemove(args: string[]) {
  const parsed = parseArgs({ args, options: {}, allowPositionals: true })
  const name = parsed.positionals[0]
  if (!name) fail("profile rm: missing <name>")
  return { name }
}

function parseConfigShow(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  return { json: parsed.values.json }
}

function parseList(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      prefix: { type: "string" },
      tag: { type: "string", multiple: true },
      type: { type: "string", multiple: true },
      author: { type: "string", multiple: true },
      limit: { type: "string" },
      "include-expired": { type: "boolean" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  return {
    prefix: parsed.values.prefix,
    tag: parsed.values.tag,
    type: parsed.values.type,
    author: parsed.values.author,
    limit: parsed.values.limit ? parseInt(parsed.values.limit, 10) : undefined,
    includeExpired: parsed.values["include-expired"],
    json: parsed.values.json,
  }
}

function parseShow(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("show: missing <id>")
  return { id, json: parsed.values.json }
}

function parseAdd(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      title: { type: "string" },
      type: { type: "string" },
      tag: { type: "string", multiple: true },
      body: { type: "string" },
      supersedes: { type: "string", multiple: true },
      expires: { type: "string" },
      author: { type: "string" },
      verify: { type: "string" },
    },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("add: missing <id>")
  return {
    id,
    title: parsed.values.title,
    type: parsed.values.type,
    tag: parsed.values.tag,
    body: parsed.values.body,
    supersedes: parsed.values.supersedes,
    expires: parsed.values.expires,
    author: parsed.values.author,
    verify: parsed.values.verify,
  }
}

function parseEdit(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      verify: { type: "string" },
      "clear-verify": { type: "boolean" },
    },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("edit: missing <id>")
  return {
    id,
    verify: parsed.values.verify,
    clearVerify: parsed.values["clear-verify"],
  }
}

function parseAccept(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      reason: { type: "string" },
      unaccept: { type: "boolean" },
      author: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("accept: missing <id>")
  return {
    id,
    reason: parsed.values.reason,
    unaccept: parsed.values.unaccept,
    author: parsed.values.author,
    json: parsed.values.json,
  }
}

function parseMerge(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      body: { type: "string" },
      yes: { type: "boolean", short: "y" },
      author: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  const [from, into] = parsed.positionals
  if (!from || !into) fail("merge: usage is 'context merge <from> <into>'")
  return {
    from,
    into,
    body: parsed.values.body,
    yes: parsed.values.yes,
    author: parsed.values.author,
    json: parsed.values.json,
  }
}

function parseSingleId(args: string[], cmd: string) {
  const parsed = parseArgs({ args, options: {}, allowPositionals: true })
  const id = parsed.positionals[0]
  if (!id) fail(`${cmd}: missing <id>`)
  return { id }
}

function parseSearch(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      limit: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  const query = parsed.positionals.join(" ").trim()
  if (!query) fail("search: missing <query>")
  return {
    query,
    limit: parsed.values.limit ? parseInt(parsed.values.limit, 10) : undefined,
    json: parsed.values.json,
  }
}

function parseTags(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  return { json: parsed.values.json }
}

function parseStale(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      days: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  return {
    days: parsed.values.days ? parseInt(parsed.values.days, 10) : undefined,
    json: parsed.values.json,
  }
}

function parseVerify(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      all: { type: "boolean" },
      failed: { type: "boolean" },
      never: { type: "boolean" },
      stale: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  return {
    id: parsed.positionals[0],
    all: parsed.values.all,
    failed: parsed.values.failed,
    never: parsed.values.never,
    stale: parsed.values.stale,
    force: parsed.values.force,
    json: parsed.values.json,
  }
}

function parseHistory(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("history: missing <id>")
  return { id, json: parsed.values.json }
}

function parseRevert(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { at: { type: "string" } },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("revert: missing <id>")
  return { id, at: parsed.values.at }
}

function parseSnapshot(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { at: { type: "string" } },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("snapshot: missing <id>")
  const at = parsed.values.at
  if (!at) fail("snapshot: missing --at=<file>")
  return { id, at }
}

function parseExport(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { out: { type: "string", short: "o" } },
    allowPositionals: true,
  })
  return { out: parsed.values.out }
}

function parseDoctor(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      memory: { type: "boolean" },
    },
    allowPositionals: true,
  })
  return { json: parsed.values.json, memory: parsed.values.memory }
}

function parseSetup(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      backend: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      agents: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  const backend = parsed.values.backend as "local" | "server" | "mirror" | undefined
  if (backend && !["local", "server", "mirror"].includes(backend)) {
    fail(`setup: --backend must be one of local | server | mirror`)
  }
  return {
    backend,
    url: parsed.values.url,
    token: parsed.values.token,
    agents: parsed.values.agents,
    profile: parsed.values.profile,
    json: parsed.values.json,
  }
}

function parseCapabilities(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  return { json: parsed.values.json }
}

function parseJoin(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      name: { type: "string" },
      "no-install": { type: "boolean" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  })
  const pairingString = parsed.positionals[0]
  if (!pairingString) fail("join: missing <pairing-string>")
  return {
    pairingString,
    name: parsed.values.name,
    noInstall: parsed.values["no-install"],
    json: parsed.values.json,
  }
}

function parseAgentsList(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  })
  return { json: parsed.values.json }
}

function parseAgentsAdd(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      name: { type: "string" },
      "json-path": { type: "string" },
      key: { type: "string", multiple: true },
      "detect-app": { type: "string" },
      "detect-cmd": { type: "string" },
      "detect-path": { type: "string" },
      "detect-always": { type: "boolean" },
      notes: { type: "string" },
      force: { type: "boolean", short: "f" },
    },
    allowPositionals: true,
  })
  const id = parsed.positionals[0]
  if (!id) fail("agents add: missing <id>")
  return {
    id,
    name: parsed.values.name,
    jsonPath: parsed.values["json-path"],
    key: parsed.values.key,
    detectApp: parsed.values["detect-app"],
    detectCommand: parsed.values["detect-cmd"],
    detectPath: parsed.values["detect-path"],
    detectAlways: parsed.values["detect-always"],
    notes: parsed.values.notes,
    force: parsed.values.force,
  }
}

function parseAgentsRemove(args: string[]) {
  const parsed = parseArgs({ args, options: {}, allowPositionals: true })
  const id = parsed.positionals[0]
  if (!id) fail("agents rm: missing <id>")
  return { id }
}

function parseSync(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      overwrite: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
    allowPositionals: true,
  })
  const direction = parsed.positionals[0]
  if (direction !== "push" && direction !== "pull") {
    fail("sync: first argument must be 'push' or 'pull'")
  }
  const active = parsed.positionals[1] // optional: explicit other profile when from/to omitted
  let from = parsed.values.from
  let to = parsed.values.to
  if (!from && !to) {
    // Shorthand: `sync push <other>` means active → other; `sync pull <other>` means other → active.
    if (!active) {
      fail("sync: provide --from and --to, or pass a profile name (active is the other side)")
    }
    // Resolve active profile lazily — keep parser pure here, sync command can call loadConfig.
    if (direction === "push") {
      from = "__ACTIVE__"
      to = active
    } else {
      from = active
      to = "__ACTIVE__"
    }
  } else if (!from || !to) {
    fail("sync: pass both --from and --to, or use the shorthand: sync <push|pull> <other-profile>")
  }
  return { direction: direction as "push" | "pull", from: from!, to: to!, overwrite: parsed.values.overwrite, dryRun: parsed.values["dry-run"], yes: parsed.values.yes }
}

function parseImport(args: string[]) {
  const parsed = parseArgs({
    args,
    options: { overwrite: { type: "boolean" } },
    allowPositionals: true,
  })
  const file = parsed.positionals[0]
  if (!file) fail("import: missing <file>")
  return { file, overwrite: parsed.values.overwrite }
}

// Suppress EPIPE when stdout is piped to something that closes early (e.g. `| head`).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0)
  throw e
})

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
