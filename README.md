# @getnodus/context

Personal context layer for AI agents. Your memory, portable across every agent you use.

Every agent you talk to starts from zero — Claude doesn't know what Cursor learned about you, Cursor doesn't know what ChatGPT learned. `@getnodus/context` is one place that stores facts about you (identity, preferences, projects, decisions). Any agent that speaks MCP can read from and write to it. You own the data.

The storage is pluggable. By default it's markdown files on your disk; you can also point it at a remote server (your own, or a hosted one) without changing how any agent or CLI command works.

## Quick start

```sh
npx -p @getnodus/context nodus-context init        # register with Claude Desktop, Claude Code, Cursor
npx -p @getnodus/context nodus-context doctor      # show backend + integration status
```

After install you can also just call `nodus-context` directly (it's added to your `$PATH` by `npm i -g @getnodus/context` or via `pnpm`/`bun` global installs).

Restart your agent. It now has tools to read and write your context.

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
  doctor [--json]                 Show config, backend, integration status
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
  search <query>                  Search (semantic when an embedder is configured)
  delete <id>                     Delete an entry
  tags                            List all tags in use
  stale [--days=90]               Find stale and expired entries

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
- `write_context` — save a new entry or update an existing one (with `type`, `supersedes`, `expires`)
- `search_context` — search across all entries (semantic when configured)
- `list_tags` — discover existing tags before inventing new ones
- `delete_context` — remove an entry

## Semantic search

Substring search works out of the box. For semantic search on the local backend, configure an embedding provider:

```sh
# Ollama (recommended — runs locally, free)
ollama pull nomic-embed-text
export NODUS_EMBEDDING_PROVIDER=ollama
export NODUS_EMBEDDING_MODEL=nomic-embed-text   # default
```

Embeddings are cached per entry at `~/.nodus/context/.embeddings/<id>.json`, keyed by content hash — they self-invalidate when the entry body changes and lazily regenerate on next search.

If the embedding service is unavailable at query time, search falls back to substring transparently.

For HTTP backends, semantic search is whatever the server implements — the client just sends the query.

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
