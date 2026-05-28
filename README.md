# @getnodus/context

Personal context layer for AI agents. Your memory, portable across every agent you use.

Every agent you talk to starts from zero — Claude doesn't know what Cursor learned about you, Cursor doesn't know what ChatGPT learned. `@getnodus/context` is one place that stores facts about you (identity, preferences, projects, decisions). Any agent that speaks MCP can read from and write to it. You own the data.

The storage is pluggable. By default it's markdown files on your disk; you can also point it at a remote server (your own, or a hosted one) without changing how any agent or CLI command works.

## Quick start

```sh
npm i -g @getnodus/context           # adds nodus-context to your $PATH
nodus-context init                   # interactive wizard: pick backend, install for detected agents
nodus-context doctor                 # show backend + integration status
```

`init` is interactive (it asks where context should live and which agents to install for). If you want a non-interactive form — or you're an AI assistant doing this for someone — use `setup` instead and see [AGENTS.md](./AGENTS.md):

```sh
nodus-context setup --backend=local --agents=detected --json
```

Prefer not to install globally? `npx -p @getnodus/context nodus-context init` works too. The `-p` flag is required because the binary name (`nodus-context`) differs from the package name (`@getnodus/context`).

After install, restart each agent so it loads the new MCP server:

- **Claude Desktop / Cursor / Cline / Windsurf / Zed** — quit and relaunch the app.
- **Claude Code / Codex CLI** — exit the current session and start a new one.

### Install in Claude Desktop with the Nodus icon

Claude Desktop renders a custom server icon only when installed as a Desktop Extension (`.mcpb` bundle). Download `nodus-context-<version>.mcpb` from [the latest GitHub release](https://github.com/getnodus/context/releases/latest) and double-click it. Claude Desktop opens an install dialog showing the Nodus avatar. The server inside still runs via `npx @getnodus/context`, so behavior matches a normal install.

Other clients display the server icon when they ship icon-rendering UI — the MCP server already advertises both SVG and PNG variants via the `serverInfo.icons` field defined in the [MCP 2025-06-18 spec](https://modelcontextprotocol.io/specification/2025-06-18/schema). No client-side config is needed.

## CLI

```
nodus-context <command>

Setup:
  init                            Interactive setup wizard
  setup --backend=local|server|mirror [--url=<u>] [--token=<t>] [--agents=...]
                                  Non-interactive, AI-friendly setup (see AGENTS.md)
  join <pairing-string>           Paste a nodus://… string from `nodus-context-server install`
                                  to configure profile + install MCPs in one shot
  uninstall [--yes] [--only=<id>] Remove the MCP server from detected agents
  doctor [--json] [--memory]      Show config + integration status
                                  (--memory: audit failed verifies / never-checked / duplicates)
  capabilities [--json]           Print supported features (for AI orientation)

Profiles:
  use <name>                      Switch active profile
  profile list                    List profiles
  profile add <name> --type=local|http|module|mirror [--url=...] [--token=...] [--use]
                                  Add a profile
  profile rm <name>               Remove a profile
  config show                     Print the full config
  config path                     Print path to config file

Agents:
  agents list [--json]            List built-in + custom agents and detection status
  agents add <id> --json-path=<file> [...]
                                  Register a custom MCP-speaking agent
  agents rm <id>                  Remove a custom agent

Entries:
  list [--prefix=X] [--tag=T] [--type=T] [--author=A]
                                  List entries
  show <id>                       Print one entry
  add <id> [--type=T] [--tag=T] [--supersedes=ID] [--expires=ISO]
                                  Create/update (stdin or $EDITOR)
  edit <id>                       Open in $EDITOR
  search <query>                  Search (BM25 lexical; semantic when an embedder is configured)
  delete <id>                     Delete an entry
  tags                            List all tags in use
  stale [--days=90]               Find stale and expired entries
  verify <id> | --all             Re-check entries with a verify: block; updates verifyStatus

History:
  history <id>                    List prior versions
  revert <id> [--at=<file>]       Restore a prior version
  snapshot <id> --at=<file>       Print a snapshot body

Portability:
  export [--out=<file>]           Export to a JSON bundle
  import <file> [--overwrite]     Restore from a bundle
  sync push|pull <other-profile> [--overwrite] [--dry-run]
                                  Copy entries between two profiles

Other:
  path [<id>]                     Print disk path
  mcp                             Run MCP server on stdio (used by agents)
```

For multi-device setup, run `nodus-context-server install` on a box you own; it emits a pairing string for `nodus-context join` on each client.

Pipe-friendly:

```sh
echo "Prefers terse responses" | nodus-context add preferences/communication --tag preferences
nodus-context list --json | jq .
nodus-context search "amsterdam"
```

## Backends

Storage is selected per profile. The CLI and MCP tools are identical regardless of backend.

### `local` — markdown files on disk (default)

```sh
nodus-context profile add personal --type=local --use
```

Files at `~/.nodus/context/<id>.md` with YAML frontmatter. Open them in any editor. Sync them with iCloud, Dropbox, or git. Atomic writes, auto-snapshot history, 256 KB body cap.

### `http` — remote server

```sh
nodus-context profile add server --type=http --url=https://memory.example.com --token=$TOKEN --use
```

Speaks the [Nodus Context HTTP Protocol](./PROTOCOL.md). Any server implementing those endpoints can be a backend — a thin wrapper over a Postgres + pgvector brain, a hosted service, anything.

### `module` — custom backend from npm or local file

```sh
nodus-context profile add work --type=module --path=@acme/context-backend-s3 --options='{"bucket":"..."}'
```

Loads any module that default-exports (or exports `createBackend`) a factory returning a `ContextBackend`. Use this to bring your own storage without forking.

### Switching

```sh
nodus-context use personal      # switch active profile
nodus-context profile list      # see what's defined
nodus-context export -o b.json  # snapshot from one backend
nodus-context use server        # switch
nodus-context import b.json     # restore into the other
```

## Attribution

Every entry records which agent wrote it. When Cursor writes something and Claude later reads it, Claude sees `author: cursor/0.50`. When agents disagree, you can audit who said what.

- **`author`** — the agent that most recently wrote the entry. Bumped on every overwrite.
- **`createdBy`** — the original creator. Preserved across rewrites so the first author isn't lost.

Resolution:
- **MCP agents** — taken from the `clientInfo` in the MCP handshake. So Claude Desktop becomes `claude-desktop/<version>`, Cursor becomes `cursor/<version>`, etc.
- **CLI** — defaults to `cli`. Override with `--author=name` or `NODUS_CONTEXT_AGENT=name`.
- **Other agents** — set `NODUS_CONTEXT_AGENT` in the env passed to the MCP server, or pass `author` directly when calling `write_context`.

Filter by author:

```sh
nodus-context list --author=cursor          # what did Cursor write?
nodus-context list --author=claude-code     # matches "claude-code" and "claude-code/4.7.0"
```

## Entry types

Every entry has a semantic `type` that hints at how the LLM should treat it:

| Type            | Meaning                                          |
|-----------------|--------------------------------------------------|
| `rule`          | always-on directive ("never use --no-verify")    |
| `preference`    | soft preference ("prefers terse responses")      |
| `fact`          | neutral information about the user/world         |
| `decision`      | historical record of a choice made               |
| `gotcha`        | warning / edge case to remember                  |
| `project-state` | current state of an ongoing project (may decay)  |
| `reference`     | pointer to an external system or document        |

Custom types are accepted; the canonical ones above are recommended.

## MCP integration

Agents see two things:

**Resources** (auto-loaded by most MCP clients at session start):

- `nodus-context://brief` — digest of always-on context: rules, preferences, identity.
- `nodus-context://entry/{id}` — one resource per entry, browseable.

**Tools** (called as needed):

- `list_context` — survey what's known; filter by prefix, tag, or type
- `read_context` — fetch one entry by id
- `write_context` — save a new entry or update an existing one (with `type`, `supersedes`, `expires`, `verify`). Response includes `relatedExisting[]` when other entries cover similar ground, nudging agents to revise rather than fork.
- `search_context` — search across all entries; hits carry a `confidence` signal (low/medium/high) so agents know which entries to verify before relying on them
- `confirm_context` — agents call this near end-of-turn on entries they actually used; runs any declared `verify:` block and stamps a confirmation
- `acknowledge_health` — agents call this after mentioning brief health issues so they don't reappear next session (enforces "mention once per session, don't lecture")
- `list_tags` — discover existing tags before inventing new ones
- `delete_context` — remove an entry

## Search

`search_context` (MCP) and `nodus-context search` (CLI) work out of the box on every backend. No model download, no API key, no daemon.

**Local backend** — BM25-based lexical search with prefix matching and field boosts (id and title weigh more than body). Tolerates word order, partial words, and ranks rarer terms higher. Good enough that most users never need anything more.

**HTTP / mirror backend** — search is delegated to the server. Whatever the server implements (vector search, hybrid, full-text) is what the client gets. Mirror merges local lexical results with server results and takes the better score per id, so paired devices benefit from server-side intelligence without losing offline search.

### Optional: semantic search on the local backend

If you run [Ollama](https://ollama.com) locally and want vector search on the local backend, opt in via env vars. Most users should not bother — lexical search is fast and accurate for personal context. Only worth it if you have many hundreds of entries and frequently search by meaning rather than keyword.

```sh
ollama pull nomic-embed-text
export NODUS_EMBEDDING_PROVIDER=ollama
export NODUS_EMBEDDING_MODEL=nomic-embed-text   # default
```

Embeddings cache to `~/.nodus/context/.embeddings/<id>.json`, keyed by content hash. If Ollama is unavailable at query time, search falls back to lexical transparently.

## Self-maintaining memory

Memory only stays useful if it stays true. `@getnodus/context` doesn't age out entries or force agents to hedge — instead, entries can declare how to check themselves, and agents are expected to verify what they cited before ending their turn.

### Verify blocks

Add a `verify:` block to any entry that points at something which can change behind your back — a repo, a URL, a file path. The entry stays in the store forever; only its *verification status* updates.

```yaml
---
id: reference/nodus
title: Nodus Context repo
type: reference
verify:
  kind: repo
  target: getnodus/context
---
The canonical repo. See README for setup.
```

Supported kinds:

- `url` — HTTP GET; ok on 2xx, failed on 4xx (except 401/403 which are treated as transient), unknown on 5xx
- `repo` — GitHub `owner/name` (or a `github.com` URL); ok if reachable AND not archived. **This is the archived-repo case**: when a repo gets archived, the entry stays but is marked failed.
- `path` — local filesystem path; ok if it exists

Run a check manually:

```sh
nodus-context verify reference/nodus       # one entry
nodus-context verify --all                 # every entry with a verify: block
```

Each run stamps `verifiedAt` + `verifyStatus` (`ok` | `failed` | `unknown`) into frontmatter and appends a confirmation record.

### Confidence on search

`search_context` returns a `confidence` field on every hit:

- `high` — recently verified and passed
- `medium` — no signal either way (the default)
- `low` — failed verification, OR has a verify block that's never been run

**Agents are explicitly instructed not to surface low confidence to users as uncertainty.** Instead, low confidence is a signal that the agent should call `confirm_context` before relying on the entry. If verification reveals the entry is wrong, the agent revises it (via `write_context` to the same id) — it doesn't create a duplicate next to the stale one.

### Revise, don't fork

`write_context` does a quick lexical search on the new content before writing. If similar entries already exist at other ids, the response includes `relatedExisting[]`. The MCP server-side instructions tell agents to prefer revising one of those entries over creating a duplicate. Combined with the verify loop, this keeps the store from accumulating sibling-versions of the same fact.

### The full loop

1. Agent searches → result has `confidence: low`.
2. Agent uses the entry anyway (no hedging to the user).
3. Before ending the turn, agent calls `confirm_context([id])`.
4. The entry's `verify:` block runs; status is stamped.
5. If passed → entry is now `high` confidence for next time.
6. If failed → entry is marked failed (stays low), and if the user provided correcting info this turn, the agent writes back the corrected body to the same id.

No background daemon, no aging-out, no deletions. Memory persists; its trust signal updates.

### Cross-agent corroboration

Every confirmation records who did it (`claude-code`, `cursor`, `codex`, `cli`, `background-verify`, …). When two or more *distinct* agents confirm the same entry within the last 30 days, confidence rises to `high` even without a fresh verify. A fact that multiple agents independently corroborate is one of the strongest signals a memory store can have — the system rewards it automatically.

### Surfacing problems

Memory only stays useful if you know when it's wrong. Three places make problems visible:

**The brief** (`nodus-context://brief`, auto-loaded by MCP clients at session start) gets a `## Memory health` section listing failed verifies, never-checked entries, and possible duplicates. Each bullet has a stable `key`. Agents mention these to the user once, then call `acknowledge_health(keys[])` — acknowledged issues are suppressed from the brief for 7 days, so "mention once" is actually enforced rather than left as a polite convention.

**Verify-on-write.** When `write_context` receives a `verify:` block, the check runs immediately with a 3-second budget. If it fails, the response includes a `verifyWarning` and the entry is stamped `verifyStatus: "failed"`. The agent sees the failure in the same turn it tried to record the memory — catches "I just saved a reference to a repo that's already archived" at the moment of recording.

**Stale-check on read.** When an agent reads an entry whose `verify:` block hasn't been run in 7+ days, a re-check fires in the background. The current read returns immediately using cached state; the next read sees the fresh result. Natural agent usage becomes self-maintenance — the more a memory gets used, the more it stays honest. Enabled automatically in the MCP server; off by default for library callers.

**`nodus-context doctor --memory`** runs the same audit on demand and prints a human-readable report:

```sh
nodus-context doctor --memory
nodus-context doctor --memory --json   # for scripts and AI assistants
```

## Implementing your own backend

Backends are just classes that implement the `ContextBackend` interface. From a third-party package:

```ts
import type { ContextBackend, WriteInput, ContextEntry } from "@getnodus/context"

export function createBackend(options: { /* your options */ }): ContextBackend {
  return {
    describe: () => ({
      type: "my-backend",
      label: "Custom storage",
      capabilities: { history: false },
    }),
    async read(id) { /* ... */ },
    async write(input) { /* ... */ },
    async delete(id) { /* ... */ },
    async list(options) { /* ... */ },
    async search(query) { /* ... */ },
    async listTags() { /* ... */ },
  }
}
```

Publish as an npm package, then:

```sh
nodus-context profile add my --type=module --path=my-backend-pkg
```

## Safety

- **Atomic writes** — entries on the local backend are written to a temp file and renamed.
- **Auto-history** (local) — every overwrite and delete snapshots the previous version. Recover with `nodus-context revert <id>`.
- **Size cap** — 256 KB per entry.
- **Path validation** — ids are constrained to safe alphanumeric segments; no `..` escapes.
- **Auth** (http backends) — bearer token via `Authorization` header.

## Config

`~/.nodus/config.json`:

```json
{
  "activeProfile": "personal",
  "profiles": {
    "personal": { "type": "local" },
    "server":   { "type": "http", "url": "...", "token": "..." }
  }
}
```

Override location with `NODUS_CONFIG_DIR`. Local storage root: `~/.nodus/context/` or `NODUS_CONTEXT_DIR`.

## License

MIT
