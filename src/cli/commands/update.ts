import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { refreshUpdateInfo } from "../update-check.js"
import { packageVersion } from "../version.js"
import { bold, cyan, dim, green, info, red, yellow } from "../output.js"

const PKG_NAME = "@getnodus/context"

export interface UpdateArgs {
  /** Don't run the installer — just print what would happen. */
  check?: boolean
  json?: boolean
}

/**
 * How the running CLI was installed. Determines which command can update it
 * in-place (or whether an update even makes sense — npx is a transient run,
 * not an install).
 */
type InstallMode = "npm" | "pnpm" | "yarn" | "npx" | "brew" | "unknown"

interface InstallSite {
  mode: InstallMode
  /** Resolved path of the running CLI script (post-symlink). */
  path: string
  /**
   * Command that would update this install. Null when not applicable
   * (npx — nothing to install) or when we can't tell.
   */
  command: { cmd: string; args: string[] } | null
}

function resolveScriptPath(): string {
  const argv1 = process.argv[1] ?? ""
  try {
    return realpathSync(argv1)
  } catch {
    return argv1
  }
}

/**
 * Heuristic install-site detection from the resolved script path. We avoid
 * shelling out to package managers to ask — that's slow and adds failure
 * modes. The path itself is enough: pnpm/yarn put globals under recognisable
 * directories, npx uses `_npx`, and everything else is npm-style.
 */
export function detectInstallSite(): InstallSite {
  const path = resolveScriptPath()
  const lower = path.toLowerCase()
  if (lower.includes("/_npx/") || lower.includes("\\_npx\\")) {
    return { mode: "npx", path, command: null }
  }
  // Homebrew formula install (hypothetical future distribution): the script
  // lives under a Cellar path. Brew installs that route through brew's node
  // (the common case today) resolve through `node_modules` and fall through
  // to the npm branch below — which is correct.
  if (lower.includes("/cellar/")) {
    return {
      mode: "brew",
      path,
      command: { cmd: "brew", args: ["upgrade", "nodus-context"] },
    }
  }
  // pnpm globals live under e.g. ~/Library/pnpm or ~/.local/share/pnpm.
  if (lower.includes("/pnpm/") || lower.includes("\\pnpm\\") || lower.includes("/.pnpm/")) {
    return {
      mode: "pnpm",
      path,
      command: { cmd: "pnpm", args: ["add", "-g", `${PKG_NAME}@latest`] },
    }
  }
  // Classic yarn global root: ~/.config/yarn/global or ~/.yarn.
  if (lower.includes("/yarn/global") || lower.includes("\\yarn\\global") || lower.includes("/.yarn/")) {
    return {
      mode: "yarn",
      path,
      command: { cmd: "yarn", args: ["global", "add", `${PKG_NAME}@latest`] },
    }
  }
  // Anything else resembling a global install — treat as npm.
  if (path.includes("node_modules")) {
    return {
      mode: "npm",
      path,
      command: { cmd: "npm", args: ["install", "-g", `${PKG_NAME}@latest`] },
    }
  }
  return { mode: "unknown", path, command: null }
}

function commandLine(c: { cmd: string; args: string[] }): string {
  return `${c.cmd} ${c.args.join(" ")}`
}

export async function cmdUpdate(args: UpdateArgs = {}): Promise<void> {
  const update = await refreshUpdateInfo()
  const site = detectInstallSite()
  const current = packageVersion()

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          current,
          latest: update?.latest ?? null,
          updateAvailable: update?.outdated ?? false,
          install: {
            mode: site.mode,
            path: site.path,
            command: site.command ? commandLine(site.command) : null,
          },
        },
        null,
        2,
      ) + "\n",
    )
    return
  }

  info(bold("context update"))
  info("")
  info(`${dim("installed:")} ${current}`)

  if (!update) {
    info(yellow("could not reach the npm registry — try again in a moment."))
    info(dim("(set NODUS_DISABLE_UPDATE_CHECK=1 to silence checks entirely)"))
    return
  }
  info(`${dim("latest:")}    ${update.latest}`)

  if (!update.outdated) {
    info("")
    info(green("already on the latest version."))
    return
  }

  if (args.check) {
    info("")
    info(yellow(`update available: ${current} → ${update.latest}`))
    if (site.command) {
      info(dim(`  run: ${commandLine(site.command)}`))
    } else if (site.mode === "npx") {
      info(dim("  (running via npx — next invocation will pick up the latest)"))
    }
    return
  }

  if (site.mode === "npx") {
    info("")
    info(yellow("Running via npx — there's no global install to upgrade."))
    info(dim("npx caches packages locally. Force a fresh fetch with:"))
    info(`  ${cyan(`npx --yes --package=${PKG_NAME}@latest nodus-context --version`)}`)
    return
  }

  if (!site.command) {
    info("")
    info(yellow("Couldn't determine how this install was set up."))
    info(dim(`Path: ${site.path}`))
    info(dim("Run one of these by hand:"))
    info(`  ${cyan(`npm install -g ${PKG_NAME}@latest`)}`)
    info(`  ${cyan(`pnpm add -g ${PKG_NAME}@latest`)}`)
    info(`  ${cyan(`yarn global add ${PKG_NAME}@latest`)}`)
    info(`  ${cyan(`brew upgrade nodus-context`)}  ${dim("(if installed via Homebrew formula)")}`)
    return
  }

  info("")
  info(`${dim("running:")} ${cyan(commandLine(site.command))}`)
  info("")
  try {
    await execPassthrough(site.command.cmd, site.command.args)
  } catch (e) {
    info("")
    info(red(`update failed: ${(e as Error).message}`))
    info(dim(`Try running the command manually: ${commandLine(site.command)}`))
    process.exitCode = 1
    return
  }
  info("")
  info(green(`updated to ${update.latest}.`))
  info(dim("Restart any running agents to pick up the new MCP server."))
}

function execPassthrough(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve()
      reject(new Error(`${cmd} exited with code ${code ?? signal}`))
    })
  })
}
