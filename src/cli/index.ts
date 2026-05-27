#!/usr/bin/env node
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
import { cmdDoctor, cmdPath } from "./commands/doctor.js"
import { cmdHistory, cmdRevert, cmdShowSnapshot } from "./commands/history.js"
import { cmdExport, cmdImport } from "./commands/portable.js"
import { cmdTags } from "./commands/tags.js"
import { cmdStale } from "./commands/stale.js"
import {
  cmdConfigPath,
  cmdConfigShow,
  cmdProfileAdd,
  cmdProfileList,
  cmdProfileRemove,
  cmdUse,
} from "./commands/profile.js"
import { bold, cyan, dim, fail, info } from "./output.js"

const USAGE = `${bold("nodus-context")} — personal context layer for AI agents

${bold("Usage:")}
  ${cyan("nodus-context")} <command> [args]

${bold("Setup:")}
  init [--yes] [--local] [--dry-run] [--only=<id>]
                                   Register MCP server with detected agents
  uninstall [--yes] [--dry-run] [--only=<id>]
                                   Remove the MCP server from detected agents
  doctor                           Show config, backend, integration status

${bold("Profiles:")}
  use <name>                       Switch active profile
  profile list                     List profiles
  profile add <name> --type=<t> [--url=<u> --token=<t> --path=<p> --options=<json>] [--use]
                                   Add a profile (type: local | http | module)
  profile rm <name>                Remove a profile
  config show                      Print the full config
  config path                      Print path to config file

${bold("Entries:")}
  list [--prefix=X] [--tag=T] [--type=T]
                                   List entries
  show <id>                        Print one entry
  add <id> [--type=T] [--title=T] [--tag=T] [--supersedes=ID] [--expires=ISO]
                                   Create/update an entry (stdin or $EDITOR)
  edit <id>                        Open an entry in $EDITOR
  search <query>                   Search (semantic when embedder configured)
  delete <id>                      Delete an entry
  tags                             List all tags in use
  stale [--days=90]                Show stale and expired entries

${bold("History:")}
  history <id>                     List prior versions
  revert <id> [--at=<file>]        Restore a prior version
  snapshot <id> --at=<file>        Print a snapshot body

${bold("Portability:")}
  export [--out=<file>]            Export all entries to JSON
  import <file> [--overwrite]      Import entries from a bundle

${bold("Other:")}
  path [<id>]                      Print disk path of root or an entry
  mcp                              Run the MCP server on stdio (used by agents)
  help [command]                   Show help

${dim("Storage: ~/.nodus/context/  (override with NODUS_CONTEXT_DIR)")}
${dim("Config:  ~/.nodus/config.json (override with NODUS_CONFIG_DIR)")}
${dim("Add --json to list/show/search/tags/history/profile-list for JSON output.")}
`

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE)
    return
  }

  switch (cmd) {
    case "init":
      return runInit(parseInit(rest))
    case "uninstall":
      return runUninstall(parseUninstall(rest))
    case "doctor":
      return cmdDoctor()
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
      return cmdEdit(parseSingleId(rest, "edit"))
    case "search":
      return cmdSearch(parseSearch(rest))
    case "delete":
    case "rm":
      return cmdDelete(parseSingleId(rest, "delete"))
    case "tags":
      return cmdTags(parseTags(rest))
    case "stale":
      return cmdStale(parseStale(rest))
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
    case "path":
      return cmdPath(rest[0])
    case "mcp":
      await import("../mcp/server.js")
      return
    case "version":
    case "--version":
    case "-v":
      info("0.0.3")
      return
    default:
      fail(`unknown command: ${cmd}\n\nrun '${bold("nodus-context help")}' for usage`)
  }
}

function parseInit(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y" },
      only: { type: "string", multiple: true },
      local: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  })
  return {
    yes: parsed.values.yes,
    only: parsed.values.only,
    local: parsed.values.local,
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
