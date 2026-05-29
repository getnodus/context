/**
 * Declarative description of an MCP-speaking agent: how to detect whether
 * it's installed on this machine, where its MCP config lives, and how to
 * write/remove our registration in it.
 *
 * Built-in agents live in `built-in.ts` as a static registry. Users can
 * add more by declaring entries in `~/.nodus/config.json` under
 * `customAgents[]` — they're loaded at the same level as built-ins.
 */

export interface AgentDefinition {
  /** Stable id used in CLI flags and config files. */
  id: string
  /** Display name. */
  name: string
  /** Path-like hint shown to the user (the file we'd write to, or its dir). */
  configPathHint: string
  /**
   * Detection rules. Any rule matching means the agent is "present". Most
   * agents only need one rule; an OR is useful when the same agent can be
   * installed in several places (e.g. /Applications vs ~/Applications).
   */
  detect: DetectRule | DetectRule[]
  /** How to read / write / remove our MCP entry. */
  install: InstallSpec
  /**
   * Optional one-line note shown in `agents list` to help users understand
   * unusual install locations or scope semantics.
   */
  notes?: string
}

export type DetectRule =
  | DetectAppBundle
  | DetectCommand
  | DetectPathExists
  | DetectAlwaysTrue

/** macOS .app bundle / Windows .exe / Linux .desktop file presence. */
export interface DetectAppBundle {
  type: "app-bundle"
  /** macOS app name without `.app`, e.g. "Claude", "Cursor", "Zed". */
  mac?: string
  /** Relative-to-Programs path for Windows, e.g. "Claude/Claude.exe". */
  win?: string
  /**
   * Lowercase Linux name; checked against /usr/share/applications/<name>.desktop
   * and the binary on PATH.
   */
  linux?: string
}

/** `command -v <name>` style PATH lookup. */
export interface DetectCommand {
  type: "command"
  name: string
}

/** A specific file or directory existing. `~` expands to home. */
export interface DetectPathExists {
  type: "path-exists"
  path: string
}

/** Always succeeds. Useful for "always-show" custom agents. */
export interface DetectAlwaysTrue {
  type: "always"
}

export type InstallSpec = InstallJsonMerge | InstallCliMcp

/**
 * Merge a `{ command, args }` entry into a JSON file under a configurable
 * key path. The vast majority of MCP clients use this shape — they differ
 * only in the file location and the key under which servers live
 * (`mcpServers` for Claude/Cursor/Cline, `context_servers` for Zed, etc.).
 */
export interface InstallJsonMerge {
  type: "json-merge"
  /** Absolute path or `~/...`. */
  path: string
  /**
   * JSON key path where MCP server entries live. Each value is a
   * `{command, args, env?}` object keyed by server name. Defaults to
   * `["mcpServers"]`.
   */
  keyPath?: string[]
  /**
   * Shape of the per-server entry value. `standard` (default) writes the
   * canonical `{command, args, env?}` used by Claude/Cursor/Cline/Zed/etc.
   * `opencode` writes OpenCode's variant: `{type: "local", command:
   * [cmd, ...args], enabled: true}`. `vscode` writes the canonical shape
   * plus an explicit `{type: "stdio"}` discriminator, which VS Code's MCP
   * schema marks as required. `jan` writes the canonical shape plus
   * `{active: true}` so Jan enables the server without a GUI toggle. Read
   * paths inverse-transform so `readMcp` returns the canonical shape
   * regardless.
   */
  entryShape?: "standard" | "opencode" | "vscode" | "jan"
}

/**
 * Shell out to the agent's own MCP CLI helper. Used by Claude Code
 * (`claude mcp add/remove`) and Codex CLI (`codex mcp add/remove`) —
 * both follow the same `<binary> mcp add <name> -- <command...>` shape.
 *
 * Most agents that expose a CLI for this use that exact subcommand
 * structure. If a future agent doesn't, we'd add a new install variant
 * rather than try to parameterize this one beyond recognition.
 */
export interface InstallCliMcp {
  type: "cli-mcp"
  /** Binary name to invoke, e.g. "claude" or "codex". Must be on $PATH. */
  binary: string
  /**
   * Extra args inserted before `add`/`remove` (e.g. `["-s", "user"]` for
   * Claude Code's user-scope install). Omit if the CLI has no scope concept.
   */
  scopeFlags?: string[]
  /**
   * Fallback file path to write our entry into (under `mcpServers`) when
   * the binary isn't on PATH. Optional — leave undefined to make the
   * install hard-fail rather than silently degrade. Claude Code sets this
   * to ~/.claude.json so a missing `claude` CLI still works on machines
   * where the desktop bundles the file but not the helper.
   */
  jsonFallbackPath?: string
}
