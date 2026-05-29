import { homedir, platform } from "node:os"
import { join } from "node:path"
import { AgentDefinition } from "./types.js"

/**
 * Built-in agent definitions, in display order. Detection paths are
 * platform-aware; config paths use ~ which is expanded at install time.
 *
 * Adding a new agent here: provide id, name, configPathHint (for display),
 * detect rules, and install spec. Most MCP clients use json-merge with
 * either `mcpServers` or `context_servers` as the key — only the file
 * path is bespoke per agent.
 */
export function builtInAgents(): AgentDefinition[] {
  const home = homedir()
  const os = platform()

  // ----- Claude Desktop -----
  const claudeDesktopConfig =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : os === "win32"
        ? join(process.env.APPDATA ?? home, "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json")

  // ----- Cline (VS Code extension by saoudrizwan) -----
  // VS Code stores extension state under a globalStorage dir whose path
  // varies per OS. We hint at it but most users will hit it as a no-op
  // unless the extension is installed.
  const vscodeGlobalStorage =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User", "globalStorage")
      : os === "win32"
        ? join(process.env.APPDATA ?? home, "Code", "User", "globalStorage")
        : join(home, ".config", "Code", "User", "globalStorage")
  const clineConfig = join(
    vscodeGlobalStorage,
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  )

  // ----- Windsurf (Codeium) -----
  const windsurfConfig = join(home, ".codeium", "windsurf", "mcp_config.json")

  // ----- Zed -----
  // Zed uses `context_servers` (not `mcpServers`) inside settings.json.
  const zedConfig =
    os === "darwin"
      ? join(home, ".config", "zed", "settings.json")
      : os === "win32"
        ? join(process.env.APPDATA ?? home, "Zed", "settings.json")
        : join(home, ".config", "zed", "settings.json")

  // ----- Cursor -----
  const cursorConfig = join(home, ".cursor", "mcp.json")

  // ----- Roo Code (VS Code extension by RooVeterinaryInc, a Cline fork) -----
  // Stores MCP entries under `mcpServers` in mcp_settings.json inside its
  // globalStorage dir. Extension storage ids are lowercased.
  const rooCodeConfig = join(
    vscodeGlobalStorage,
    "rooveterinaryinc.roo-cline",
    "settings",
    "mcp_settings.json",
  )

  // ----- VS Code GitHub Copilot (native MCP, mcp.json with `servers` key) -----
  // VS Code's user-level MCP file lives in the User profile dir. Different
  // file name and key than Cursor / Claude Desktop: `mcp.json` + `servers`.
  const vscodeUserDir =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User")
      : os === "win32"
        ? join(process.env.APPDATA ?? home, "Code", "User")
        : join(home, ".config", "Code", "User")
  const vscodeMcpConfig = join(vscodeUserDir, "mcp.json")

  // ----- Gemini CLI (Google) -----
  // Has `gemini mcp add <name> -- <command...>` (same shape as claude/codex),
  // with a json fallback at ~/.gemini/settings.json under `mcpServers`.
  const geminiFallback = join(home, ".gemini", "settings.json")

  // ----- Amp (Sourcegraph) -----
  // Settings live at ~/.config/amp/settings.json. MCP entries are nested
  // under the flat key "amp.mcpServers" — a single literal dotted key, not
  // a path. Local server entry shape matches our {command, args, env}.
  const ampConfig = join(home, ".config", "amp", "settings.json")

  // ----- OpenClaw -----
  // The lobster. Config at ~/.openclaw/openclaw.json with MCP entries
  // nested under `mcp.servers`. Detect via the `openclaw` CLI binary.
  const openclawConfig = join(home, ".openclaw", "openclaw.json")

  // ----- OpenCode (sst/opencode) -----
  // Config at ~/.config/opencode/opencode.json. MCP entries nest under
  // `mcp` BUT use a non-standard per-entry shape: `{type: "local",
  // command: [cmd, ...args], enabled: true}` instead of the canonical
  // `{command, args}`. Handled by entryShape: "opencode".
  const opencodeConfig = join(home, ".config", "opencode", "opencode.json")

  return [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      configPathHint: claudeDesktopConfig,
      detect: { type: "app-bundle", mac: "Claude", win: "Claude/Claude.exe", linux: "claude" },
      install: { type: "json-merge", path: claudeDesktopConfig },
    },
    {
      id: "claude-code",
      name: "Claude Code",
      configPathHint: join(home, ".claude.json"),
      detect: { type: "command", name: "claude" },
      install: {
        type: "cli-mcp",
        binary: "claude",
        scopeFlags: ["-s", "user"],
        jsonFallbackPath: join(home, ".claude.json"),
      },
      notes: "Installed via `claude mcp add -s user` — handles scope across all your projects.",
    },
    {
      id: "codex-cli",
      name: "Codex CLI",
      configPathHint: join(home, ".codex", "config.toml"),
      detect: { type: "command", name: "codex" },
      install: { type: "cli-mcp", binary: "codex" },
      notes: "Installed via `codex mcp add` — writes to ~/.codex/config.toml (TOML, single global scope).",
    },
    {
      id: "cursor",
      name: "Cursor",
      configPathHint: cursorConfig,
      detect: [
        { type: "app-bundle", mac: "Cursor", win: "cursor/Cursor.exe", linux: "cursor" },
        { type: "command", name: "cursor" },
      ],
      install: { type: "json-merge", path: cursorConfig },
    },
    {
      id: "cline",
      name: "Cline (VS Code)",
      configPathHint: clineConfig,
      detect: { type: "path-exists", path: join(vscodeGlobalStorage, "saoudrizwan.claude-dev") },
      install: { type: "json-merge", path: clineConfig },
      notes: "Installs into the VS Code Cline extension's settings. The file is created if needed.",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      configPathHint: windsurfConfig,
      detect: [
        { type: "app-bundle", mac: "Windsurf", win: "Windsurf/Windsurf.exe", linux: "windsurf" },
        { type: "command", name: "windsurf" },
      ],
      install: { type: "json-merge", path: windsurfConfig },
    },
    {
      id: "zed",
      name: "Zed",
      configPathHint: zedConfig,
      detect: [
        { type: "app-bundle", mac: "Zed", win: "Zed/Zed.exe", linux: "zed" },
        { type: "command", name: "zed" },
      ],
      install: { type: "json-merge", path: zedConfig, keyPath: ["context_servers"] },
      notes: "Zed nests servers under `context_servers`, not `mcpServers`.",
    },
    {
      id: "vscode",
      name: "VS Code (GitHub Copilot)",
      configPathHint: vscodeMcpConfig,
      detect: [
        { type: "app-bundle", mac: "Visual Studio Code", win: "Microsoft VS Code/Code.exe", linux: "code" },
        { type: "command", name: "code" },
        { type: "path-exists", path: vscodeUserDir },
      ],
      install: { type: "json-merge", path: vscodeMcpConfig, keyPath: ["servers"] },
      notes: "VS Code's MCP file is mcp.json with the `servers` key (not `mcpServers`).",
    },
    {
      id: "roo-code",
      name: "Roo Code (VS Code)",
      configPathHint: rooCodeConfig,
      detect: { type: "path-exists", path: join(vscodeGlobalStorage, "rooveterinaryinc.roo-cline") },
      install: { type: "json-merge", path: rooCodeConfig },
      notes: "Installs into the Roo Code extension's mcp_settings.json (Cline-compatible shape).",
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      configPathHint: geminiFallback,
      detect: { type: "command", name: "gemini" },
      install: {
        type: "cli-mcp",
        binary: "gemini",
        scopeFlags: ["-s", "user"],
        jsonFallbackPath: geminiFallback,
      },
      notes: "Installed via `gemini mcp add -s user` (user scope → ~/.gemini/settings.json). Without -s user the CLI defaults to project scope and writes ./.gemini/settings.json in the cwd. Falls back to ~/.gemini/settings.json when the CLI isn't on PATH.",
    },
    {
      id: "amp",
      name: "Amp (Sourcegraph)",
      configPathHint: ampConfig,
      detect: { type: "command", name: "amp" },
      install: { type: "json-merge", path: ampConfig, keyPath: ["amp.mcpServers"] },
      notes: "Amp uses a flat `amp.mcpServers` key in settings.json — the dot is part of the key, not a path.",
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      configPathHint: openclawConfig,
      detect: { type: "command", name: "openclaw" },
      install: { type: "json-merge", path: openclawConfig, keyPath: ["mcp", "servers"] },
      notes: "OpenClaw nests MCP servers under `mcp.servers` in ~/.openclaw/openclaw.json.",
    },
    {
      id: "opencode",
      name: "OpenCode",
      configPathHint: opencodeConfig,
      detect: { type: "command", name: "opencode" },
      install: {
        type: "json-merge",
        path: opencodeConfig,
        keyPath: ["mcp"],
        entryShape: "opencode",
      },
      notes: "OpenCode entries use {type, command-as-array, enabled} — handled by entryShape: opencode.",
    },
  ]
}
