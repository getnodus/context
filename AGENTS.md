# AGENTS.md — playbook for AI assistants installing `@getnodus/context`

You are an AI assistant. A human has asked you to set up `@getnodus/context` for them. This file tells you exactly what to do.

## What the tool is

A personal-context layer for MCP-speaking AI agents. It exposes `read_context` / `write_context` / `search_context` tools that all your fellow agents (Claude Desktop, Claude Code, Codex CLI, Cursor, Cline, Windsurf, Zed) read and write through a single shared store. The store is one of:

- **local** — markdown files at `~/.nodus/context/`. Default. No network. Per-machine.
- **server** — remote HTTP server speaking the Nodus Context Protocol. Shared across devices.
- **mirror** — local primary + remote secondary. Reads stay fast and offline-safe; writes mirror to the server.

## The flow you should follow

1. **Install the package** if it isn't already.

   ```sh
   npm i -g @getnodus/context
   ```

2. **Check the version and current state** before doing anything else.

   ```sh
   nodus-context capabilities --json
   nodus-context doctor --json
   ```

   Parse the JSON. `capabilities.version` tells you what features exist. `doctor.profile`, `doctor.backend`, `doctor.agents`, `doctor.issues` tell you what's already configured and what's broken. If a `setup` command isn't listed in `capabilities.commands`, the user is on a version older than `0.0.12` — tell them to upgrade.

3. **Ask the user where their context should live.** Pick one based on their answer:

   | If the user says… | use these flags |
   | --- | --- |
   | "just this machine" / "I don't have a server" / "keep it simple" | `--backend=local` |
   | "I already have a server" / pastes a `nodus://…` pairing string | `--backend=mirror --url=<the-string-or-url>` (mirror is almost always better than pure server) |
   | "make it work across all my devices" / "I want to share with my other Mac" | ask if they have a server. If yes → mirror. If no → suggest they run `nodus-context-server install` on a box they own, then run `setup` here with the resulting pairing string. |

   **Don't suggest "pure server" (`--backend=server`).** Mirror is strictly better for almost everyone: same persistence, plus offline reads and faster startup. Only steer them to `server` if they explicitly insist on it.

4. **Run setup non-interactively** with the right flags. Always pass `--json`.

   ```sh
   nodus-context setup --backend=local --agents=detected --json
   # or
   nodus-context setup --backend=mirror --url=nodus://TOKEN@HOST:PORT --agents=detected --json
   ```

   Parse the result. The shape is:

   ```jsonc
   {
     "ok": true,
     "profile": { "name": "cloud", "type": "mirror", "url": "http://…", "authed": true },
     "agents": {
       "installed": [{ "id": "claude-code", "status": "installed" }, …],
       "failed":    [{ "id": "cursor",      "error": "…" }],
       "skipped":   [{ "id": "zed",         "reason": "not installed on this machine" }]
     },
     "notes": ["restart each installed agent to load the new MCP server"]
   }
   ```

5. **Report to the user** in plain language. Summarize: backend chosen, agents installed, anything that failed, and the restart instruction. Don't dump the raw JSON unless they ask for it.

## Flag reference (everything you might pass)

```
nodus-context setup
  --backend=local|server|mirror   where context lives (required)
  --url=<u>                       server URL or nodus:// pairing string (server/mirror)
  --token=<t>                     bearer token (omit if pairing string carries one)
  --agents=detected|all|none|<a,b,…>
                                  which agents to install for (default: detected)
  --profile=<name>                profile name to write (default: derived from backend)
  --json                          machine-readable output (always pass this)
```

## Doctor → action mapping

When `doctor --json` returns `issues[]`, map each issue to a fix you can offer the user:

| issue contains… | action |
| --- | --- |
| `broken install (missing file …)` | `nodus-context init --repair --yes` |
| `stale registration (app not installed)` | `nodus-context uninstall --only=<id> --yes` |
| `backend unreachable: …` (when backend is http or mirror) | check the user's network / Tailscale / token; offer to switch back to local with `nodus-context use default` |

## Things you must NOT do

- Don't run the interactive wizard (`nodus-context init` with no flags) — it requires a TTY you don't have. Use `setup` instead.
- Don't write or modify `~/.nodus/config.json` directly. Use `setup` / `profile add` / `use` so atomicity and validation are preserved.
- Don't store the user's bearer token in any conversation log, memory entry, commit, or shared context. If you have to reference it, only refer to its location (`~/.nodus/server-token.txt`) — never the value.
- Don't ask the user to restart their entire computer. Only the MCP-hosting agents (Claude Desktop, Claude Code session, Codex CLI session) need to restart, and only once after install.

## Things you can offer that humans often don't know about

- **`nodus-context-server install`** — interactive one-shot that turns any box (Linux/macOS) into a Nodus Context server with systemd or launchd persistence. Outputs a pairing string the user can paste into other devices.
- **`nodus-context join <pairing-string>`** — single command on a client device that takes the pairing string from the server and configures everything (profile, active switch, MCP install). Equivalent to `setup --backend=server --url=<pairing>`.
- **mDNS auto-discovery** — when the wizard or `setup` is on the same LAN as a `nodus-context-server`, the server is found automatically; the user doesn't have to type the URL.

## Sanity-check your work after setup

```sh
nodus-context doctor --json | jq '.backend, .agents[] | select(.installed)'
```

You should see the backend the user picked, plus an `installed: true` entry for every agent in `agents.installed[]` from your `setup` result.
