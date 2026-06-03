<div align="center">

<img src="assets/nodus-mark.svg" alt="Nodus" width="100" height="100">

# @getnodus/context

**Personal context layer for AI agents.**
<br>
Your memory, portable across every agent you use.

<br>

[![npm](https://img.shields.io/npm/v/@getnodus/context?style=flat-square&labelColor=000000&color=DB2F61)](https://www.npmjs.com/package/@getnodus/context)
[![MCP](https://img.shields.io/badge/protocol-MCP-000000?style=flat-square&labelColor=000000)](https://modelcontextprotocol.io)
[![local-first](https://img.shields.io/badge/local--first-no_telemetry-000000?style=flat-square&labelColor=000000)](#network-use)
[![license](https://img.shields.io/badge/license-MIT-000000?style=flat-square&labelColor=000000)](#license)

</div>

---

Every agent you talk to starts from zero. Claude doesn't know what Cursor learned about you; Cursor doesn't know what ChatGPT learned. `@getnodus/context` is one place that stores facts about you — identity, preferences, projects, decisions — that any agent speaking [MCP](https://modelcontextprotocol.io) can read from and write to.

- **Portable** — one memory, shared across Claude, Cursor, Codex, Windsurf, Cline, Zed, and any other MCP client.
- **Yours** — stored as plain markdown on your disk by default. No telemetry, no analytics, no account required.
- **Pluggable** — keep it local, or point it at a remote server you own. Agents and commands work the same either way.
- **Self-maintaining** — entries can verify themselves against the real world, so your memory stays true instead of quietly going stale.

```sh
npm i -g @getnodus/context    # adds the `context` command to your $PATH
context install               # local memory + detected agents
```

Then restart your agents so they load the new MCP server, and they'll start reading and writing your context automatically.

## Quick start

```sh
npm i -g @getnodus/context
context install     # simple default: local memory + detected agents
context status      # show memory, integrations, and health
```

`install` is the default path. For a scriptable setup with explicit backend choices
(or if you're an AI assistant doing this for someone), use `setup` and see
**[AGENTS.md](./AGENTS.md)**:

```sh
context setup --backend=local --agents=detected --json
```

Prefer not to install globally? `npx -p @getnodus/context context install` works too — the `-p` flag is needed because the binary (`context`) differs from the package name.

After installing, reload each agent so it picks up the new MCP server:

- **Claude Desktop / Cursor / Cline / Windsurf / Zed** — quit and relaunch.
- **Claude Code / Codex CLI** — exit the session and start a new one.

> The legacy `nodus-context` command still works as an alias, so existing shell history and CI keep running. New scripts should use `context`.

### Claude Desktop with the Nodus icon

Claude Desktop shows a custom server icon only when installed as a Desktop Extension (`.mcpb`). Download `nodus-context-<version>.mcpb` from the [latest release](https://github.com/getnodus/context/releases/latest) and double-click it — Claude Desktop opens an install dialog with the Nodus avatar. The server still runs via `npx @getnodus/context`, so behavior is identical to a normal install. Other clients render the icon automatically via the [MCP icon spec](https://modelcontextprotocol.io/specification/2025-06-18/schema); no config needed.

## How agents use it

Once installed, MCP clients see your context without any prompting from you:

**Resources** (auto-loaded at session start by most clients):

- `nodus-context://brief` — a digest of always-on context: rules, preferences, identity, plus a **This workspace** section of entries relevant to the repo the agent is currently in (matched against the MCP client's workspace roots, falling back to its working directory).
- `nodus-context://entry/{id}` — one resource per entry, browseable.

**Simple tools** (the normal path for agents):

| Tool | Purpose |
| --- | --- |
| `recall_context` | Search or list shared memory |
| `remember_context` | Save a natural-language memory; Context infers ids, types, tags, and likely updates |

**Advanced tools** (for precise maintenance or exact entry control):

| Tool | Purpose |
| --- | --- |
| `list_context` | Survey what's known; filter by prefix, tag, or type |
| `read_context` | Fetch one entry by id |
| `write_context` | Save or update an entry; flags likely duplicates so agents revise instead of fork |
| `search_context` | Search all entries; hits carry a confidence signal |
| `confirm_context` | Re-check entries an agent actually used before ending its turn |
| `accept_context` | Mark a known-failing check as expected, on your say-so |
| `merge_context` | Combine two entries you've agreed are duplicates |
| `acknowledge_health` | Suppress an already-surfaced memory-health issue so it isn't repeated |
| `list_tags` | Discover existing tags before inventing new ones |
| `delete_context` | Remove an entry |

## CLI

The `context` command mirrors everything agents can do, plus setup and maintenance. A few common ones:

```sh
context remember "Prefers terse responses"
context recall "communication style"
context list --tag preferences        # advanced: filter by --prefix / --tag / --type / --author
context search "amsterdam"            # advanced: lexical search (semantic if configured)
context show preferences/prefers-terse-responses
context list --json | jq .            # everything is pipe- and JSON-friendly
```

Run `context --help` (or `context <command> --help`) for the full reference, including profiles (`use`, `profile`, `config`), agent management (`agents`), memory hygiene (`verify`, `accept`, `merge`, `stale`), history (`history`, `revert`, `snapshot`), and portability (`export`, `import`, `sync`).

## Backends

Storage is chosen per profile. The CLI and MCP tools are identical regardless of which you pick.

**`local` — markdown on disk (default).** Files at `~/.nodus/context/<id>.md` with YAML frontmatter. Open them in any editor; sync with iCloud, Dropbox, or git. Atomic writes, auto-snapshot history, 256 KB body cap.

```sh
context profile add personal --type=local --use
```

**`http` — a remote server you own.** Speaks the [Nodus Context HTTP Protocol](./PROTOCOL.md); any server implementing it can be a backend.

```sh
context profile add server --type=http --url=https://memory.example.com --token=$TOKEN --use
```

**`module` — a custom backend from npm or a local file.** Bring your own storage without forking — see [Implementing your own backend](#implementing-your-own-backend).

```sh
context profile add work --type=module --path=@acme/context-backend-s3 --options='{"bucket":"..."}'
```

Switch any time with `context use <profile>`; move data between backends with `context export` / `context import`. For multi-device setup, run `context-server install` on a box you own and paste its pairing string into `context connect` on each client. `connect` creates a mirror profile by default: local reads stay fast and offline-safe, and writes sync to the server.

## Sharing memory

Most people should use one of three modes:

```sh
context install
# local-only memory on this device

context-server install
# run this once on the Mac or Linux box that should hold shared memory

context connect nodus://...
# run this on each client device; existing local memories are reconciled with the server
```

The recommended shared mode is **mirror**: every device keeps a local cache for fast offline reads, and writes are mirrored to the server. If local and server both have an entry, Context keeps the newer copy. Use `context sync reconcile <profile>` to manually reconcile two profiles, or `context status` to see whether the active profile is local-only, server-only, or mirrored.

## Entry types

Every entry has a semantic `type` that hints at how an agent should treat it:

| Type | Meaning |
| --- | --- |
| `rule` | Always-on directive ("never use `--no-verify`") |
| `preference` | Soft preference ("prefers terse responses") |
| `fact` | Neutral information about you or the world |
| `decision` | Historical record of a choice made |
| `gotcha` | Warning or edge case to remember |
| `project-state` | Current state of an ongoing project (may decay) |
| `reference` | Pointer to an external system or document |

Custom types are accepted; the ones above are the recommended canon.

## Attribution

Every entry records which agent wrote it, so you can audit who said what when agents disagree. `author` is the most recent writer (bumped on every overwrite); `createdBy` preserves the original author. MCP agents are identified from the handshake (`claude-desktop/<version>`, `cursor/<version>`, …); the CLI defaults to `cli` and can be overridden with `--author` or `NODUS_CONTEXT_AGENT`.

```sh
context list --author=cursor        # what did Cursor write?
context list --author=claude-code   # matches "claude-code" and "claude-code/4.7.0"
```

## Search

`search_context` (MCP) and `context search` (CLI) work out of the box on every backend — no model download, no API key, no daemon.

- **Local** — BM25 lexical search with prefix matching and field boosts (id and title weigh more than body). Tolerant of word order and partial words; accurate enough that most users never need more.
- **HTTP / mirror** — search is delegated to the server (vector, hybrid, full-text — whatever it implements). Mirror profiles merge local and server results so paired devices keep working offline.

Want semantic search on the local backend? If you run [Ollama](https://ollama.com), opt in with `NODUS_EMBEDDING_PROVIDER=ollama` (model defaults to `nomic-embed-text`). Embeddings cache by content hash, and search falls back to lexical transparently if Ollama is unavailable. Most users don't need this — lexical is fast and accurate for personal context.

## Self-maintaining memory

Memory only stays useful if it stays true. Instead of aging entries out or making agents hedge, `@getnodus/context` lets entries check themselves and expects agents to verify what they cited.

**Verify blocks.** Attach a `verify:` block to any entry that points at something which can change behind your back — a repo, a URL, a file path. The entry lives forever; only its *verification status* updates.

```yaml
---
id: reference/nodus
title: Nodus Context repo
type: reference
verify:
  kind: repo        # url | repo | path
  target: getnodus/context
---
The canonical repo. See README for setup.
```

```sh
context verify reference/nodus   # one entry
context verify --failed          # or --all / --never / --stale
```

**Confidence.** Search hits carry a confidence signal — `high` (recently verified), `medium` (no signal), or `low` (failed, or never checked). Agents are told not to surface low confidence to you as uncertainty; instead it's a cue to re-check the entry before relying on it, and to revise it in place if it turns out wrong rather than spawning a duplicate.

**It mostly runs itself.** Checks fire inline on write, in the background when a stale entry is read, and on demand via `context doctor --memory`. The session brief surfaces failed verifies, never-checked entries, and likely duplicates — once per session, not as a recurring lecture. And when two distinct agents independently confirm the same fact within 30 days, confidence rises to `high` on its own.

There's no background daemon, no aging-out, and no automatic deletion. Memory persists; only its trust signal moves.

## Network use

`@getnodus/context` is local-first. The only outbound calls it makes on its own behalf:

| Outbound call | What it does | When | Disable |
| --- | --- | --- | --- |
| Update check | GETs `registry.npmjs.org` to compare your version to the latest published. 1.5s timeout, silent on failure. | At most once per 24h on CLI/MCP startup and `doctor`/`update`. Skipped in CI and dev builds. | `NODUS_DISABLE_UPDATE_CHECK=1` |
| Verify blocks | `kind: url` fetches your URL; `kind: repo` checks the GitHub API; `kind: path` is local-only. | On write, on explicit verify, and as a background re-check when an entry's verify is 7+ days old (MCP only). | `NODUS_DISABLE_BACKGROUND_VERIFY=1`; tune timeout with `NODUS_VERIFY_TIMEOUT_MS` |
| HTTP / mirror sync | Sends reads, writes, and ack sync to your configured server URL. | Only when you've configured an `http`/`mirror` profile. | Switch to a `local` profile |
| Ollama embeddings | Sends text to your Ollama endpoint to enable semantic search. | Only when you opt in with `NODUS_EMBEDDING_PROVIDER=ollama`. | Unset `NODUS_EMBEDDING_PROVIDER` |

**No telemetry. No analytics. Entry contents never leave the local backend unless you configure a remote profile.**

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

Override the config location with `NODUS_CONFIG_DIR`; the local storage root with `NODUS_CONTEXT_DIR`.

## Implementing your own backend

A backend is just a class implementing the `ContextBackend` interface — the same surface used by the CLI, the MCP server, and the HTTP handler, so adding one makes it available everywhere.

```ts
import type { ContextBackend, WriteInput, ContextEntry } from "@getnodus/context"

export function createBackend(options: { /* your options */ }): ContextBackend {
  return {
    describe: () => ({ type: "my-backend", label: "Custom storage", capabilities: { history: false } }),
    async read(id) { /* ... */ },
    async write(input) { /* ... */ },
    async delete(id) { /* ... */ },
    async list(options) { /* ... */ },
    async search(query) { /* ... */ },
    async listTags() { /* ... */ },
  }
}
```

Publish it to npm, then `context profile add my --type=module --path=my-backend-pkg`. The interface lives in `src/backends/types.ts`.

## Safety

- **Atomic writes** — local entries are written to a temp file and renamed.
- **Auto-history** (local) — every overwrite and delete snapshots the prior version; recover with `context revert <id>`.
- **Size cap** — 256 KB per entry.
- **Path validation** — ids are constrained to safe segments; no `..` escapes.
- **Auth** (http) — bearer token via the `Authorization` header.

## Docs

- **[AGENTS.md](./AGENTS.md)** — playbook for AI assistants that set up or use this tool. The MCP server points agents here.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — dev setup, the test loop, and how to make your first PR.
- **[PROTOCOL.md](./PROTOCOL.md)** — wire format for the HTTP backend and `context-server`.
- **[SECURITY.md](./SECURITY.md)** — how to report vulnerabilities and what's in scope.
- **[CHANGELOG.md](./CHANGELOG.md)** — what changed and when.

## License

MIT
