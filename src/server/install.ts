import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises"
import { homedir, hostname, platform, networkInterfaces } from "node:os"
import { join, dirname } from "node:path"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { ask, askSecret, confirm, selectOne } from "../cli/wizard/prompt.js"
import { bold, cyan, dim, green, info, red, yellow } from "../cli/output.js"
import { packageVersion } from "../cli/version.js"
import { encodePairing } from "./pairing.js"

const SERVICE_NAME = "context"

export interface InstallOptions {
  /** Non-interactive mode: use flags + defaults, never prompt. */
  yes?: boolean
  /** Override prompts. All optional; missing values are prompted unless --yes. */
  port?: number
  rootDir?: string
  token?: string
  host?: string
  /** Whether to install as a persistent service. Default true in interactive. */
  installService?: boolean
  /** Where to write systemd unit / launchd plist. Override only for tests. */
  unitDirOverride?: string
}

interface InstallResult {
  url: string
  pairing: string
  token: string
  rootDir: string
  port: number
  host: string
  serviceInstalled: boolean
  unitPath?: string
}

/**
 * Interactive server install: gather config, write the service definition,
 * enable+start it, and emit a pairing string clients can paste.
 *
 * Idempotent: re-running offers to overwrite an existing service. Token
 * is regenerated each time unless one is supplied via --token or saved
 * locally in ~/.nodus/server-token.txt.
 *
 * Only writes files the user owns or can `sudo` to. Refuses to touch
 * loopback bindings (--host 127.0.0.1) without a token — there's no
 * value in pretending to authenticate something only localhost reaches.
 */
export async function runServerInstall(opts: InstallOptions): Promise<InstallResult> {
  info(bold(`\ncontext-server install  ${dim(`v${packageVersion()}`)}`))
  info(dim("Set up context as a persistent service on this machine.\n"))

  // ----- root dir -----
  const defaultRoot =
    platform() === "linux"
      ? "/srv/context"
      : join(homedir(), ".nodus", "context")
  const rootDir =
    opts.rootDir ?? (opts.yes ? defaultRoot : await ask("Data directory", { default: defaultRoot }))

  // ----- port -----
  const port =
    opts.port ??
    (opts.yes ? 7475 : parseInt(await ask("Port", { default: "7475" }), 10))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`)
  }

  // ----- host (bind) -----
  const tailscaleIp = await detectTailscaleIp()
  const lanIp = detectLanIp()
  const hostChoices: Array<{ value: string; label: string; hint?: string }> = []
  if (lanIp) hostChoices.push({ value: "0.0.0.0", label: `LAN — bind 0.0.0.0`, hint: `reachable at http://${lanIp}:${port}` })
  if (tailscaleIp) hostChoices.push({ value: tailscaleIp, label: `Tailscale only`, hint: `bind ${tailscaleIp} · only your tailnet` })
  hostChoices.push({ value: "0.0.0.0", label: `All interfaces (0.0.0.0)`, hint: `LAN + Tailscale + anything routed in` })
  hostChoices.push({ value: "127.0.0.1", label: `Loopback only (127.0.0.1)`, hint: `same-machine only — no token enforced` })

  const host =
    opts.host ??
    (opts.yes
      ? lanIp
        ? "0.0.0.0"
        : "127.0.0.1"
      : await selectOne("Bind to:", hostChoices, 0))

  // ----- token -----
  const wantToken = host !== "127.0.0.1" && host !== "localhost"
  const tokenFile = join(homedir(), ".nodus", "server-token.txt")
  let token = opts.token
  if (wantToken && !token) {
    token = await readSavedToken(tokenFile)
    if (token) info(dim(`Reusing existing token at ${tokenFile}`))
  }
  if (wantToken && !token) {
    if (opts.yes) {
      token = randomBytes(32).toString("hex")
    } else {
      const generate = await confirm(
        "Generate a fresh token? (alternative: paste one)",
        true,
      )
      if (generate) {
        token = randomBytes(32).toString("hex")
      } else {
        token = (await askSecret("Token (hidden)")).trim()
        if (!token) throw new Error("token required for non-loopback bind")
      }
    }
  }

  // ----- prepare data dir -----
  await ensureDir(rootDir)

  // ----- save token locally for the operator and service wrappers -----
  if (token) {
    await ensureDir(dirname(tokenFile))
    await writeFile(tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 })
    await chmod(tokenFile, 0o600)
  }

  // ----- service install? -----
  const installService =
    opts.installService ??
    (opts.yes ? true : await confirm("Install as a service (auto-start on boot)?", true))

  let unitPath: string | undefined
  if (installService) {
    if (platform() === "linux") {
      unitPath = await writeSystemdUnit({
        rootDir,
        port,
        host,
        token,
        tokenFile,
        unitDir: opts.unitDirOverride ?? "/etc/systemd/system",
      })
    } else if (platform() === "darwin") {
      unitPath = await writeLaunchdPlist({
        rootDir,
        port,
        host,
        tokenFile: token ? tokenFile : undefined,
        plistDir:
          opts.unitDirOverride ?? join(homedir(), "Library", "LaunchAgents"),
      })
    } else {
      info(yellow(`service install not supported on ${platform()}; you'll need to run context-server manually`))
    }
  }

  // ----- pairing string -----
  const publishHost = host === "0.0.0.0" ? (tailscaleIp ?? lanIp ?? hostname()) : host
  const url = `http://${publishHost}:${port}`
  const pairing = encodePairing({ url, token })

  const result: InstallResult = {
    url,
    pairing,
    token: token ?? "",
    rootDir,
    port,
    host,
    serviceInstalled: !!unitPath,
    ...(unitPath ? { unitPath } : {}),
  }

  // ----- final report -----
  info("")
  info(bold("✓ installed"))
  info(`  ${dim("URL    →")} ${cyan(url)}${token ? dim(" (token required)") : dim(" (no token — loopback)")}`)
  info(`  ${dim("data   →")} ${cyan(rootDir)}`)
  if (unitPath) info(`  ${dim("unit   →")} ${cyan(unitPath)}`)
  if (token) info(`  ${dim("token  →")} ${cyan(join(homedir(), ".nodus", "server-token.txt"))} ${dim("(chmod 600)")}`)
  info("")
  info(bold("Pair clients with one of:"))
  info(`  ${green("$")} ${cyan(`context connect ${pairing}`)}`)
  info(`  …or paste the pairing string into any client's setup wizard.`)
  if (token) {
    info("")
    info(
      yellow(
        "  Pairing strings embed your bearer token. Treat them like passwords — " +
          "don't paste into public chats, issues, or shared logs.",
      ),
    )
  }
  info("")
  return result
}

// ---------------------------------------------------------------------------

async function writeSystemdUnit(opts: {
  rootDir: string
  port: number
  host: string
  token?: string
  tokenFile?: string
  unitDir: string
}): Promise<string> {
  const user = process.env.USER ?? process.env.LOGNAME ?? "root"

  // Tokens go in a separate, mode-600 EnvironmentFile instead of the
  // service file. The .service file ends up world-readable under
  // /etc/systemd/system; an inline `Environment=…` directive would leak
  // the token to every local user.
  const envFilePath = `/etc/${SERVICE_NAME}.env`
  if (opts.token) {
    await sudoWrite(envFilePath, `NODUS_CONTEXT_TOKEN=${opts.token}\n`, { mode: 0o600 })
  }

  const unit = [
    "[Unit]",
    "Description=Nodus Context HTTP Server",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    ...(opts.token ? [`EnvironmentFile=${envFilePath}`] : []),
    `ExecStart=/usr/bin/env context-server --host ${opts.host} --port ${opts.port} --root ${opts.rootDir}`,
    "Restart=on-failure",
    "RestartSec=5",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n")

  const unitPath = join(opts.unitDir, `${SERVICE_NAME}.service`)
  await sudoWrite(unitPath, unit)
  // Reload + (re)enable + restart. Use restart so re-running install
  // picks up any config change without us having to detect "did anything
  // change."
  await runOrFail("sudo", ["systemctl", "daemon-reload"])
  await runOrFail("sudo", ["systemctl", "enable", `${SERVICE_NAME}.service`])
  await runOrFail("sudo", ["systemctl", "restart", `${SERVICE_NAME}.service`])
  // Give it a beat to fail, then check.
  await new Promise((r) => setTimeout(r, 800))
  const status = await runQuiet("sudo", ["systemctl", "is-active", `${SERVICE_NAME}.service`])
  if (status.stdout.trim() !== "active") {
    info(yellow(`warning: service is ${status.stdout.trim() || "not active"}; check journalctl -u ${SERVICE_NAME}`))
  }
  return unitPath
}

async function writeLaunchdPlist(opts: {
  rootDir: string
  port: number
  host: string
  tokenFile?: string
  plistDir: string
}): Promise<string> {
  const label = "co.nodus.context"
  const plistPath = join(opts.plistDir, `${label}.plist`)
  const args = [
    "context-server",
    "--host",
    opts.host,
    "--port",
    String(opts.port),
    "--root",
    opts.rootDir,
    ...(opts.tokenFile ? ["--token-file", opts.tokenFile] : []),
  ]
  const argsBlock = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argsBlock}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), "Library", "Logs", `${label}.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), "Library", "Logs", `${label}.err.log`)}</string>
</dict>
</plist>
`
  await ensureDir(opts.plistDir)
  await writeFile(plistPath, plist, "utf8")
  await chmod(plistPath, 0o644)
  // Unload first so launchctl picks up changes; ignore failure.
  await runQuiet("launchctl", ["unload", plistPath])
  await runOrFail("launchctl", ["load", plistPath])
  return plistPath
}

// ---------------------------------------------------------------------------

async function ensureDir(p: string): Promise<void> {
  try {
    await mkdir(p, { recursive: true })
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e
  }
}

async function readSavedToken(path: string): Promise<string | undefined> {
  try {
    const token = (await readFile(path, "utf8")).trim()
    return token || undefined
  } catch {
    return undefined
  }
}

async function sudoWrite(
  path: string,
  contents: string,
  opts: { mode?: number } = {},
): Promise<void> {
  // Try a plain write first — works when the user already owns the path.
  try {
    await writeFile(path, contents, "utf8")
    if (opts.mode !== undefined) await chmod(path, opts.mode)
    return
  } catch (e: any) {
    if (e?.code !== "EACCES" && e?.code !== "EPERM") throw e
  }
  // Fall back to `sudo tee` so the credential prompt (if any) goes through
  // the user's normal sudo session rather than us re-implementing it.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("sudo", ["tee", path], { stdio: ["pipe", "ignore", "inherit"] })
    proc.on("error", reject)
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`sudo tee ${path} exited ${code}`))))
    proc.stdin.write(contents)
    proc.stdin.end()
  })
  if (opts.mode !== undefined) {
    // chmod via sudo so it works on root-owned paths too.
    await runOrFail("sudo", ["chmod", opts.mode.toString(8), path])
  }
}

async function runOrFail(cmd: string, args: string[]): Promise<void> {
  const r = await runQuiet(cmd, args)
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || "no stderr"}`)
  }
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

async function detectTailscaleIp(): Promise<string | undefined> {
  const r = await runQuiet("tailscale", ["ip", "-4"])
  if (r.code === 0) {
    const ip = r.stdout.trim().split("\n")[0]?.trim()
    if (ip && /^[0-9.]+$/.test(ip)) return ip
  }
  return undefined
}

function detectLanIp(): string | undefined {
  const nets = networkInterfaces()
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue
    if (name.startsWith("lo")) continue
    if (name.startsWith("docker") || name.startsWith("br-") || name.startsWith("veth")) continue
    if (name.startsWith("tailscale") || name === "tailscale0") continue
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address
    }
  }
  return undefined
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
