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

   Parse the JSON. `capabilities.version` tells you what features exist — if it's less than `0.0.12`, tell the user to upgrade. `doctor.profile`, `doctor.backend`, `doctor.agents`, `doctor.issues` tell you what's already configured and what's broken.

   **If the user is already configured** (`doctor.profile.active` is set and `doctor.backend` has a type), don't blindly re-run `setup`. Ask whether they want to keep the existing backend, switch to a different one, or just install MCP for additional agents. The `setup` command overwrites the named profile and re-points `activeProfile`, so re-running unnecessarily can disrupt a working setup.

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
     "notes": ["restart each installed agent to load the new MCP server: …"]
   }
   ```

   **Exit code**: `setup --json` exits non-zero when `ok: false` (any agent install failed). The JSON still prints to stdout — read both. Treat exit-0 + `ok: true` as success; anything else means investigate `agents.failed[]`.

5. **Verify reachability** for server/mirror backends, since the profile is written even if the backend is unreachable:

   ```sh
   nodus-context list --limit=1 --json
   ```

   A clean exit with a JSON array confirms the client can talk to the backend. An error here means the profile is configured but unusable — surface that to the user.

6. **Report to the user** in plain language. Summarize: backend chosen, agents installed, anything that failed, and the restart instruction (see "Restart specifics" below). Don't dump the raw JSON unless they ask for it.

   **Restart specifics** — be concrete, not "restart your agents":
   - **Claude Desktop, Cursor, Cline, Windsurf, Zed**: quit and relaunch the application.
   - **Claude Code, Codex CLI**: exit the current session (`/exit` or Ctrl-D) and start a new one. The currently-running session won't pick up the new MCP server.

   Never tell the user to reboot their computer.

## Flag reference (everything you might pass)

```
nodus-context setup
  --backend=local|server|mirror   where context lives (defaults to local if omitted)
  --url=<u>                       server URL or nodus://… pairing string (required for server/mirror)
  --token=<t>                     bearer token (omit if pairing string carries one;
                                  if both are present, --token wins)
  --agents=detected|all|none|<a,b,…>
                                  which agents to install for (default: detected)
  --profile=<name>                profile name to write (default: derived from backend —
                                  local→"default", server→"server", mirror→"cloud")
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
- **Don't store or log the user's bearer token.** This includes the token itself AND any pairing string (`nodus://TOKEN@HOST:PORT`) that carries one — the token is embedded inside it. Don't paste either into commit messages, memory entries, PR descriptions, chat transcripts, or shared context. If you have to reference the token, refer only to its location (`~/.nodus/server-token.txt`).
- Don't ask the user to reboot their computer. Only the MCP-hosting agents need to restart (see "Restart specifics" above), once, after install.

## Things you can offer that humans often don't know about

- **`nodus-context-server install`** — interactive one-shot that turns any box (Linux/macOS) into a Nodus Context server with systemd or launchd persistence. Outputs a pairing string the user can paste into other devices.
- **`nodus-context join <pairing-string>`** — single command on a client device that takes the pairing string from the server and configures everything (profile, active switch, MCP install). Equivalent to `setup --backend=server --url=<pairing>`.
- **mDNS auto-discovery** — when the wizard or `setup` is on the same LAN as a `nodus-context-server`, the server is found automatically; the user doesn't have to type the URL.

## Sanity-check your work after setup

```sh
nodus-context doctor --json \
  | jq '{backend, installed: [.agents[] | select(.installed) | .id], issues}'
```

You should see the backend the user picked, an `installed[]` list containing every agent in `agents.installed[]` from your `setup` result, and an empty `issues[]`.

A clean `list` round-trips through the backend, which `doctor` alone doesn't fully exercise:

```sh
nodus-context list --limit=1 --json
```

This is the single most reliable post-setup health check for server / mirror backends.
