#!/usr/bin/env node
import { parseArgs } from "node:util"
import { LocalBackend } from "../backends/index.js"
import { startServer } from "./index.js"
import { startAdvertising } from "./discovery.js"
import { runServerInstall } from "./install.js"
import { packageVersion } from "../cli/version.js"

const HELP = `nodus-context-server — Nodus Context HTTP Protocol server

Usage:
  nodus-context-server [options]            Run the server (foreground)
  nodus-context-server install [options]    Interactive: write service, start, emit pairing string
  nodus-context-server install --yes        Non-interactive (defaults: 0.0.0.0:7475, /srv/nodus-context, fresh token)

Options:
  --port <n>      Port to bind (default 7475, or $PORT)
  --host <addr>   Bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --root <dir>    Storage directory (default ~/.nodus/context, or $NODUS_CONTEXT_DIR)
  --token <t>     Require Authorization: Bearer <t> on every request
                  (or $NODUS_CONTEXT_TOKEN)
  --quiet         Suppress per-request access log
  --no-advertise  Don't broadcast over mDNS (LAN discovery off)
  -h, --help      Show this help
  -v, --version   Show version

When binding to anything other than 127.0.0.1, set a token. The handler
returns 401 on every request if no Authorization: Bearer header matches.

Examples:
  nodus-context-server                                    # local only
  nodus-context-server --host 0.0.0.0 --token "$T"        # Tailscale-accessible
  nodus-context-server --root /srv/nodus --port 8080 --token "$T"
`

async function main(): Promise<void> {
  // Top-level subcommand handling: argv[0] === "install" routes to the
  // installer. Anything else falls through to the inline server.
  if (process.argv[2] === "install") {
    return runInstallSubcommand(process.argv.slice(3))
  }
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string" },
      host: { type: "string" },
      root: { type: "string" },
      token: { type: "string" },
      quiet: { type: "boolean" },
      "no-advertise": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  })

  if (parsed.values.help) {
    process.stdout.write(HELP)
    return
  }
  if (parsed.values.version) {
    process.stdout.write(packageVersion() + "\n")
    return
  }

  const port = parsed.values.port
    ? parseInt(parsed.values.port, 10)
    : process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : 7475
  const host = parsed.values.host ?? "127.0.0.1"
  const token = parsed.values.token ?? process.env.NODUS_CONTEXT_TOKEN
  const root = parsed.values.root ?? process.env.NODUS_CONTEXT_DIR

  if (host !== "127.0.0.1" && host !== "localhost" && !token) {
    process.stderr.write(
      `error: --token is required when binding to ${host} (anything other than 127.0.0.1).\n` +
        `  set --token <secret> or NODUS_CONTEXT_TOKEN, or bind to 127.0.0.1 for trusted-loopback only.\n`,
    )
    process.exit(2)
  }

  const backend = new LocalBackend({ ...(root ? { rootDir: root } : {}) })
  await backend.init()

  const quiet = !!parsed.values.quiet
  const running = await startServer(backend, {
    port,
    host,
    ...(token ? { token } : {}),
    onRequest: quiet
      ? undefined
      : ({ method, path, status, durationMs }) => {
          const ts = new Date().toISOString()
          process.stdout.write(`${ts} ${method} ${path} ${status} ${durationMs}ms\n`)
        },
  })

  const tokenNote = token ? "(token required)" : "(no token — trusted loopback only)"
  process.stdout.write(`nodus-context-server v${packageVersion()} listening on ${running.url} ${tokenNote}\n`)
  process.stdout.write(`backend: ${backend.describe().label}\n`)

  // Loopback-only servers can't be reached by other devices anyway, so
  // advertising would only mislead. Suppress in that case (and when the
  // operator opts out explicitly).
  const shouldAdvertise =
    !parsed.values["no-advertise"] && host !== "127.0.0.1" && host !== "localhost"
  let advertise: { stop: () => Promise<void> } | undefined
  if (shouldAdvertise) {
    advertise = startAdvertising({
      port,
      txt: {
        version: packageVersion(),
        protocol: "1",
        backend: backend.describe().label,
        auth: token ? "bearer" : "none",
      },
    })
    process.stdout.write(`mdns: advertising _nodus-context._tcp on the local network\n`)
  }

  const shutdown = async (sig: NodeJS.Signals) => {
    process.stdout.write(`\nreceived ${sig}, shutting down...\n`)
    try {
      await advertise?.stop()
      await running.close()
      await backend.close?.()
    } finally {
      process.exit(0)
    }
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

async function runInstallSubcommand(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y" },
      port: { type: "string" },
      host: { type: "string" },
      root: { type: "string" },
      token: { type: "string" },
      "no-service": { type: "boolean" },
    },
    allowPositionals: false,
  })
  await runServerInstall({
    yes: parsed.values.yes,
    port: parsed.values.port ? parseInt(parsed.values.port, 10) : undefined,
    rootDir: parsed.values.root,
    token: parsed.values.token,
    host: parsed.values.host,
    installService: parsed.values["no-service"] ? false : undefined,
  })
}

main().catch((e) => {
  process.stderr.write(`nodus-context-server failed: ${e?.message ?? e}\n`)
  process.exit(1)
})
