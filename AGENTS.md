# AGENTS.md — playbook for AI assistants using `@getnodus/context`

You are an AI assistant. A human has asked you to set up or interact with `@getnodus/context`. This file is written for you specifically — the human is unlikely to read it. Treat it as your single source of truth for what to do.

## What the tool is

A personal-context layer for MCP-speaking AI agents. It exposes `read_context` / `write_context` / `search_context` (and friends) so every agent the user runs — Claude Desktop, Claude Code, Codex CLI, Cursor, Cline, Windsurf, Zed — reads and writes through one shared store.

The CLI is **`context`** (e.g. `context doctor`). The legacy name `nodus-context` is kept as an alias for existing installs and shell history; new scripts and your instructions to users should always use `context`.

The store is one of:

- **local** — markdown files at `~/.nodus/context/`. Default. No network. Per-machine.
- **server** — remote HTTP server speaking the Nodus Context Protocol. Shared across devices.
- **mirror** — local primary + remote secondary. Reads stay fast and offline-safe; writes mirror to the server. Almost always the right pick when a server is available.

## The flow you should follow for setup

1. **Install the package** if it isn't already.

   ```sh
   npm i -g @getnodus/context
   ```

2. **Check the version and current state** before doing anything else.

   ```sh
   context capabilities --json
   context doctor --json
   ```

   Parse the JSON. `capabilities.version` tells you what features exist — if it's less than `0.1.0`, tell the user to upgrade (you'll be missing the verify/confirm/accept/merge surface). `doctor.profile`, `doctor.backend`, `doctor.agents`, `doctor.memory`, `doctor.issues` give you a full picture: what's configured, what's broken, what's in the store, and what (if anything) needs cleanup.

   **`doctor --json` now folds in `memory` health.** You don't need a second `doctor --memory --json` call to know whether the store has failed verifies, never-checked entries, or duplicates. Use the inline `memory` field for orientation; only run `doctor --memory --json` when you want the full per-entry breakdown.

   **If the user is already configured** (`doctor.profile.active` is set and `doctor.backend` has a type), don't blindly re-run `setup`. Ask whether they want to keep the existing backend, switch to a different one, or just install MCP for additional agents. The `setup` command overwrites the named profile and re-points `activeProfile`, so re-running unnecessarily can disrupt a working setup.

3. **Ask the user where their context should live.** Pick one based on their answer:

   | If the user says… | use these flags |
   | --- | --- |
   | "just this machine" / "I don't have a server" / "keep it simple" | `--backend=local` |
   | "I already have a server" / pastes a `nodus://…` pairing string | `--backend=mirror --url=<the-string-or-url>` (mirror is almost always better than pure server) |
   | "make it work across all my devices" / "I want to share with my other Mac" | ask if they have a server. If yes → mirror. If no → suggest they run `context-server install` on a box they own, then run `setup` here with the resulting pairing string. |

   **Don't suggest "pure server" (`--backend=server`).** Mirror is strictly better for almost everyone: same persistence, plus offline reads and faster startup. Only steer them to `server` if they explicitly insist on it.

4. **Run setup non-interactively** with the right flags. Always pass `--json`.

   ```sh
   context setup --backend=local --agents=detected --json
   # or
   context setup --backend=mirror --url=nodus://TOKEN@HOST:PORT --agents=detected --json
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
   context list --limit=1 --json
   ```

   A clean exit with a JSON array confirms the client can talk to the backend. An error here means the profile is configured but unusable — surface that to the user.

6. **Report to the user** in plain language. Summarize: backend chosen, agents installed, anything that failed, and the restart instruction (see "Restart specifics" below). Don't dump the raw JSON unless they ask for it.

   **Restart specifics** — be concrete, not "restart your agents":
   - **Claude Desktop, Cursor, Cline, Windsurf, Zed**: quit and relaunch the application.
   - **Claude Code, Codex CLI**: exit the current session (`/exit` or Ctrl-D) and start a new one. The currently-running session won't pick up the new MCP server.

   Never tell the user to reboot their computer.

## How to actually USE the tool from within an MCP session

The setup is one-time. The bulk of your interaction is reading and writing entries inside conversations.

### MCP tool surface at a glance

| Tool | Use when |
| --- | --- |
| `read_context(id)` | Fetch one entry by id. |
| `list_context({prefix, tag, type, limit})` | Survey what's known; filter to narrow. |
| `search_context(query)` | Find entries by content; every hit carries a `confidence` field. |
| `list_tags()` | Before inventing a new tag — reuse existing tags so the store stays coherent. |
| `write_context({id, body, type, tags, supersedes, expires, verify})` | Save or update a durable fact. Returns `relatedExisting[]` and `verifyWarning` you must act on. |
| `confirm_context([ids])` | Call near end-of-turn on entries you actually cited; runs verify + stamps a confirmation. |
| `accept_context(id, reason)` | Only after the user explicitly confirms a failing verify is intentional. |
| `merge_context(from, into, body?)` | Only after the user agrees two entries are duplicates. |
| `acknowledge_health([keys])` | Call after mentioning brief health issues so they don't reappear next session. |
| `delete_context(id)` | Only when the user explicitly asks to remove an entry. Prefer `write_context` to revise, or `accept_context` to silence a failing verify. The local backend keeps a snapshot for `context revert <id>` if the user changes their mind. |

Resources (read directly, no tool call needed): `nodus-context://brief` (auto-loaded at session start), `nodus-context://entry/{id}` (one per entry).

### At session start
Read the `nodus-context://brief` resource. It gives you rules (always-on directives), preferences (soft preferences), identity, and a `## Memory health` section listing problems the user should be aware of. The brief is loaded automatically by most clients; if yours doesn't, read it explicitly.

### Deciding what to save — the embarrassment test
Before calling `write_context`, ask: *"Would I be embarrassed to make this same mistake — or ask this same question — again next session?"* If yes, save. If no, skip.

This replaces type-category matching with a felt-shame check you can run mid-conversation. Things that pass: capability false-negatives the user corrected, preference reveals, "we tried that and it broke", non-obvious constraints. Things that fail: code structure, file paths, recent commits — re-derivable from the repo or `git log`.

Knowing what to log is the rare trait. Most agents either hoard everything (store rots) or save nothing (user re-teaches the same thing every session). The embarrassment test is concrete enough to act on without thinking.

### The correction reflex — dedup via edit, never by restraint
When the user contradicts a false claim of yours — especially the pattern *"I can't / don't have access / not possible"* → *"yes you can, here's how"* — that's a high-signal save. Run this sequence before continuing the task:

1. `search_context` for the topic. Inspect `relatedExisting[]` on any subsequent `write_context` too.
2. **If a related entry exists → edit it in place** (write to the same id; refine the rule, sharpen the reasoning, replace the stale claim). Use `supersedes` only when the replacement is structurally different.
3. **If nothing related exists → write a new entry.**

Never skip the save to avoid noise. Duplicate accumulation is prevented by step 1, not by being conservative up front. The cost of an extra entry is much smaller than the cost of the user re-correcting the same thing next session.

### Announce on novel saves, stay quiet on edits
When you create a *new* entry, tell the user in one short line: *"I added that to memory so we won't forget."* Use "we" — memory is the shared scratchpad, not your private notebook. The announcement gives the user a chance to object in the moment ("no, that was a one-off — don't save it") before the entry calcifies.

When you *edit* an existing entry, or refresh a verify/confirmation, stay silent. Narrating every touch becomes chatter and the user stops reading the line. The split — loud on novel, quiet on maintenance — keeps the signal high.

### When you learn something durable about the user
Once the embarrassment test passes, call `write_context`. Pick a sensible id (path-style: `user/identity`, `preferences/communication`, `projects/<name>`). Set the `type` field correctly — it's how future agents know how to treat the entry:

- `rule` — always-on directive ("never use --no-verify")
- `preference` — soft preference ("prefers terse responses")
- `fact` — neutral info
- `decision` — historical record
- `gotcha` — warning / edge case
- `project-state` — current state (decays over time)
- `reference` — pointer to an external resource

If the entry references something that can rot (a repo, URL, file path), attach a `verify` block. The system runs it inline on write; if it fails, the response includes `verifyWarning` — surface that to the user and offer to revise.

### When `write_context` returns `relatedExisting[]`
The store thinks similar entries already exist. Each has a `relation`:
- `same-subject` — likely a duplicate; **strongly prefer** overwriting (write to the same id) or `supersedes`-linking.
- `similar` — sibling concept; usually leave both.

Never silently fork. Duplicate accumulation is the #1 way personal-context stores rot.

### When the user says a known-failing verify is intentional
Don't repeatedly nag. Call `accept_context(id, reason)`. The entry stays put; it just stops appearing as a problem. A later passing verify auto-clears the accept so a *re*-failure would still surface. Never accept on the user's behalf without explicit confirmation.

### When you find duplicates the user agrees to merge
Call `merge_context(from, into)`. The bodies are joined (by default `into`'s body, a `---` divider, then `from`'s), tags are unioned, `supersedes` records the merge link, and `from` is deleted. Pass an explicit `body` if you want to write a hand-consolidated version instead of the default join.

### Before ending your turn
Call `confirm_context([ids])` on entries you actually cited. It runs any declared `verify` block and stamps a confirmation. Two distinct agents confirming the same entry within 30 days lifts its `confidence` to `high` — that cross-agent corroboration is the strongest trust signal the store has.

### When you mention a memory-health issue from the brief
Call `acknowledge_health([keys])` with the keys of the issues you brought up. The brief suppresses acknowledged issues for 7 days so you don't lecture the user every session. On HTTP/mirror backends the acks sync across devices, so a "mention once" on the laptop won't repeat on the desktop.

### Confidence signal
`search_context` hits carry a `confidence` field. The contract:
- `low` → verify before relying on it. **Don't hedge to the user about staleness.** Call `confirm_context` on the id, then use it.
- `medium` → use normally.
- `high` → cite freely.

## Flag reference (everything you might pass)

```
context setup
  --backend=local|server|mirror   where context lives (defaults to local if omitted)
  --url=<u>                       server URL or nodus://… pairing string (required for server/mirror)
  --token=<t>                     bearer token (omit if pairing string carries one;
                                  if both are present, --token wins)
  --agents=detected|all|none|<a,b,…>
                                  which agents to install for (default: detected)
  --profile=<name>                profile name to write (default: derived from backend —
                                  local→"default", server→"server", mirror→"cloud")
  --json                          machine-readable output (always pass this)

context add <id>
  --type=<rule|preference|fact|decision|gotcha|project-state|reference>
  --title=<t> --tag=<t> (repeatable) --supersedes=<id> (repeatable) --expires=<iso>
  --body=<text>                   inline body (else stdin or $EDITOR)
  --verify=kind:target            kind ∈ {url, repo, path}; target is the URL, owner/name,
                                  or filesystem path to check (you'll thank yourself later)

context verify
  <id>                            check one entry
  --all | --failed | --never | --stale
                                  targeted re-checks (combine selectors freely)
  --force                         include accepted entries in the run

context accept <id>
  --reason="..."                  optional explanation stored alongside the entry
  --unaccept                      reverse a prior accept

context merge <from> <into>
  --body=<text>                   override the default body join

context doctor
  --json                          machine-readable; includes memory health in one call
  --memory                        deep human-readable audit
  --memory --json                 deep audit, machine-readable
```

## Doctor → action mapping

When `doctor --json` returns `issues[]`, map each issue to a fix:

| issue contains… | action |
| --- | --- |
| `broken install (missing file …)` | `context init --repair --yes` |
| `stale registration (app not installed)` | `context uninstall --only=<id> --yes` |
| `backend unreachable: …` (when backend is http or mirror) | check the user's network / Tailscale / token; offer to switch back to local with `context use default` |

When `doctor --json` returns `memory.failedVerifies[]` non-empty, map each entry:

| condition | action |
| --- | --- |
| User says the failure is expected | `context accept <id> --reason="…"` |
| User wants to fix the underlying reference | `context edit <id>` (then `context verify <id>`) |
| User doesn't know what to do | offer both options; don't decide unilaterally |

When `doctor --json` returns `memory.duplicateClusters[]` non-empty, offer `context merge <a> <b>` and let the user pick which side is canonical.

## Environment variables

- `NODUS_CONTEXT_DIR` — override local storage root (default `~/.nodus/context`)
- `NODUS_CONFIG_DIR` — override config root (default `~/.nodus`)
- `NODUS_CONTEXT_AGENT` — override the recorded author name on writes
- `NODUS_VERIFY_TIMEOUT_MS` — verify timeout in ms (default 8000; inline verify-on-write caps at 3000 regardless)
- `NODUS_DISABLE_BACKGROUND_VERIFY=1` — suppress stale-on-read background verifies (metered/offline use)
- `NODUS_EMBEDDING_PROVIDER=ollama` — opt into semantic search (default: lexical BM25)

## Things you must NOT do

- Don't run the interactive wizard (`context init` with no flags) — it requires a TTY you don't have. Use `setup` instead.
- Don't write or modify `~/.nodus/config.json` directly. Use `setup` / `profile add` / `use` so atomicity and validation are preserved.
- **Don't store or log the user's bearer token.** This includes the token itself AND any pairing string (`nodus://TOKEN@HOST:PORT`) that carries one — the token is embedded inside it. Don't paste either into commit messages, memory entries, PR descriptions, chat transcripts, or shared context. If you have to reference the token, refer only to its location (`~/.nodus/server-token.txt`).
- **Don't accept failures on the user's behalf without explicit confirmation.** `accept_context` is a user-driven escape hatch; if you call it without asking, the user loses visibility into a real failure.
- Don't ask the user to reboot their computer. Only the MCP-hosting agents need to restart (see "Restart specifics" above), once, after install.
- Don't hedge to the user about memory being stale. Confidence is a signal *for you*, not for them — use it to decide whether to call `confirm_context`, then write or speak with confidence about the outcome.

## Things you can offer that humans often don't know about

- **`context-server install`** — interactive one-shot that turns any box (Linux/macOS) into a Nodus Context server with systemd or launchd persistence. Outputs a pairing string the user can paste into other devices.
- **`context join <pairing-string>`** — single command on a client device that takes the pairing string from the server and configures everything (profile, active switch, MCP install). Equivalent to `setup --backend=server --url=<pairing>`.
- **mDNS auto-discovery** — when the wizard or `setup` is on the same LAN as a `context-server`, the server is found automatically; the user doesn't have to type the URL.
- **Verify blocks on memories with references** — attach `--verify=repo:owner/name` (or `url:…`, `path:…`) when adding an entry that points at something which can rot. The system will keep itself honest.

## Sanity-check your work after setup

```sh
context doctor --json \
  | jq '{backend, installed: [.agents[] | select(.installed) | .id], memory: .memory.urgency, issues}'
```

You should see the backend the user picked, an `installed[]` list containing every agent in `agents.installed[]` from your `setup` result, `memory.urgency.urgent == 0`, and an empty `issues[]`.

A clean `list` round-trips through the backend, which `doctor` alone doesn't fully exercise:

```sh
context list --limit=1 --json
```

This is the single most reliable post-setup health check for server / mirror backends.
