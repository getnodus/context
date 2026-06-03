# Changelog

All notable changes to `@getnodus/context` are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

<!-- New entries land here. Group under topical subheadings (e.g. *Agent registry*, *Self-maintaining memory*) to match past releases. -->

### Rename: `nodus-context` → `context` (breaking)

- **The MCP server is now named `context`.** It registered under `nodus-context` before; agents that previously saw `mcp__nodus-context__*` tools now see `mcp__context__*`. `context install` / `context repair` migrate existing setups in place — they write the `context` entry and strip the leftover `nodus-context` one across all install kinds (JSON-merge, YAML-merge, and the `claude`/`codex` CLIs), so upgraders don't end up with two servers pointing at the same backend. Any allowlists or permission rules that reference the old `mcp__nodus-context__*` tool names need updating once.
- **Resource URIs moved** from `nodus-context://brief` and `nodus-context://entry/{id}` to `context://brief` and `context://entry/{id}`.
- **The `nodus-context`, `nodus-context-mcp`, and `nodus-context-server` binary aliases are removed.** Use `context`, `context-mcp`, and `context-server`. Scripts or CI invoking the old names must switch.
- **Kept as-is:** the `@getnodus/context` package name, the `~/.nodus` storage/config directory, the `NODUS_*` environment variables, and the human-facing **Nodus Context** title and HTTP-protocol name. The export bundle is now tagged `context-bundle`; import still accepts the legacy `nodus-context-bundle` tag. The mDNS service type is now `context`, so a renamed server and a pre-rename client won't auto-discover each other during pairing — fall back to manual URL entry in that mixed case.

### Brief

- **Workspace-aware brief.** The session-start brief now adds a **This workspace** section surfacing entries whose id segments or tags match the repo the agent is working in — so an agent starts already knowing about *this* project, not just always-on rules. The workspace is detected from the MCP client's [roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) (leaf and parent directory names, so both a repo and a Conductor branch folder match), falling back to the server's working directory when the client exposes no roots. Matching is on whole id/tag segments (so `context` won't match `mycontextual`), entries already shown under Rules/Preferences/Identity aren't repeated, and the `listRoots` round-trip is bounded by a 1s timeout. Clients that expose no workspace see exactly the brief they saw before. The brief renderer moved to its own module (`src/mcp/brief.ts`) and is now unit-tested.

### Build

- **Migrated to TypeScript 6.** TS 6 stopped picking up `@types/node` implicitly, so the build flooded with errors for `process`, `fetch`, `Buffer`, `node:*` imports and other Node globals. `tsconfig.json` now declares `"types": ["node"]` explicitly, restoring resolution. `pnpm typecheck && pnpm test` are green on TS 6.0.3 across the Node 20/22/24 matrix.
- **New `yaml-merge` install kind.** The registry could only merge into JSON files; YAML-config clients had to be parked. There's now a `yaml-merge` installer that round-trips through the `yaml` Document API, so a merge preserves the user's other keys *and* their comments — it doesn't reformat the file. It handles both collection styles we've seen: a sequence keyed by an inner `name` (Continue) and a map keyed by server name with renamed fields (Goose). Adds one direct dependency (`yaml`).

### Agent registry

- **New client: Continue.** `setup` can now detect and install into [Continue](https://continue.dev). Continue's documented global config is YAML at `~/.continue/config.yaml`, where `mcpServers` is a *sequence* of `{name, command, args}` rather than the object map every other client uses; the new `yaml-merge` installer upserts our entry by `name` and leaves the user's models/rules/other servers untouched. Detected via the `cn` CLI or the `~/.continue` directory. (Unblocks #25.)
- **New client: Goose (Block).** `setup` can now detect and install into [Goose](https://block.github.io/goose/). Goose keeps MCP servers as `extensions` in `~/.config/goose/config.yaml`, with a per-entry shape that renames `command`→`cmd` and adds `type: stdio` / `enabled: true` / `timeout` (new `goose` entry shape). Detected via the `goose` binary, the macOS/Linux app, or the `~/.config/goose` directory. (Unblocks #26.)
- **New client: 5ire.** `setup` can now detect and install into [5ire](https://github.com/nanbingxyz/5ire). 5ire keeps its MCP servers in `mcp.json` (in its Electron `userData` dir) under the canonical `mcpServers` object map; entries are written with `isActive: true` (new `5ire` entry shape) because 5ire only auto-connects servers flagged active. Detected via the `5ire` app bundle/binary or its config directory.
- **New client: BoltAI.** `setup` can now detect and install into [BoltAI](https://boltai.com), the native macOS client. Its local MCP servers live in `~/.boltai/mcp.json` (a home dotfile, not under `~/Library/Application Support`) using the canonical `mcpServers` object map, so a standard `json-merge` install applies. Detected via the `BoltAI.app` bundle or the `~/.boltai` directory.
- **New client: Witsy.** `setup` can now detect and install into [Witsy](https://github.com/nbonamy/witsy). Witsy keeps a Claude-compatible top-level `mcpServers` object map in `settings.json` (in its Electron `userData` dir) and unions it with its own native server list at read time, so a standard `json-merge` install applies. Detected via the `Witsy` app bundle/binary or its config directory.
- **Three new clients: LM Studio, Warp, and Jan.** `setup` can now detect and install into LM Studio (`~/.lmstudio/mcp.json`), Warp (global `~/.warp/.mcp.json`), and Jan (`mcp_config.json` in Jan's data folder). All three use the canonical `mcpServers` object map; Jan entries are written with `active: true` so the server is enabled without a GUI toggle.
- **LM Studio macOS path fallback.** Some macOS installs read `~/.cache/lm-studio/mcp.json` and never create `~/.lmstudio` ([upstream bug #1371](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1371)). Install now writes the cache path when that's the directory LM Studio actually uses, so the registration isn't silently ignored; the documented path is still preferred when present.
- **Gemini CLI now installs at user scope.** `gemini mcp add` defaults to *project* scope, which wrote the server into a `./.gemini/settings.json` in whatever directory `setup` happened to run from. The registry now passes `-s user`, so the server is registered globally in `~/.gemini/settings.json` — matching the JSON fallback and the behavior every other agent gives.
- **VS Code entries carry an explicit `type: "stdio"`.** VS Code infers the transport today, but its MCP schema marks `type` as required; the new `vscode` entry shape writes it so the registration stays valid against stricter validation.

### Documentation

- **Network use table.** README now lists each outbound call, when it fires, and the matching env-var kill switch or control path. The update-check and verify rows note the exact triggers (1.5s timeout; once at MCP-server start; 7-day stale-on-read background verify, on in the MCP server and off by default for library/CLI callers).

## 0.1.1 — 2026-05-28

A small follow-up to 0.1.0 that broadens client coverage and tightens the memory-discipline contract agents see at startup. 0.1.0 was prepped but never published, so this is the first release on npm after 0.0.12 — the 0.1.0 notes below still apply.

### Agent registry

- **6 new clients** — VS Code Copilot, Roo Code, Gemini CLI, Amp, OpenClaw, OpenCode. The registry is now 13 clients deep, all driven from the same `built-in.ts` table.
- **`entryShape` on `json-merge`.** OpenCode's MCP entry is non-standard (`{type, command: [...], enabled}` instead of the usual `command: string` + `args: []`); the registry shape lets it round-trip without a bespoke adapter.

### Memory-discipline rules

- **Three rules** threaded through `AGENTS.md` and the MCP server `instructions`:
  - **Embarrassment test** — would the user be embarrassed if you forgot this next session? If no, don't save it.
  - **Correction reflex** — when the user corrects an entry, edit-in-place; don't fork a duplicate, don't go quiet.
  - **Announce on novel saves** — surface the first save of a memory in a session so the user knows what you wrote.
- **Playbook URL surfaced** via `capabilities --json` and the CLI `--help` footer, so agents can find `AGENTS.md` without scraping the README.

## 0.1.0 — 2026-05-28 *(prepped, not released)*

A foundation release. Memory now maintains itself — entries declare how to check that they're still true, agents call a confirmation tool before ending a turn, and problems surface in the auto-loaded brief instead of hiding in metadata. The CLI is renamed from `nodus-context` to `context` (the old name still works), local search is BM25 lexical out of the box, and several escape hatches (`accept`, `merge`) make memory hygiene a one-command operation. The minor-version bump reflects the magnitude of the diff since 0.0.12; no breaking changes for existing users.

### Self-maintaining memory

- **Verify blocks.** Entries can declare `verify: { kind: url | repo | path, target: ... }`. The check runs on demand, inline on write (3s budget), and in the background when a stale entry is read. Stamps `verifyStatus` + `verifiedAt` into frontmatter; never deletes the entry.
- **Confidence on search results.** `search_context` hits carry `confidence: low | medium | high`, derived from verify state + freshness. The contract for agents: `low` means *verify before relying on this*, not *warn the user*. Computed client-side when servers don't supply it, so the signal is uniform across local/http/mirror.
- **Cross-agent corroboration.** Two or more distinct agents confirming the same entry within 30 days lifts confidence to `high` automatically. The strongest trust signal a memory store has.
- **`confirm_context` MCP tool / `context verify` CLI.** Re-runs the verify block on demand. The MCP server instructs agents to call this near end-of-turn on entries they cited.
- **Verify-on-write.** `write_context` runs the verify spec inline when present and returns a `verifyWarning` if it fails — catches "I just saved a reference to a repo that's already archived" at the moment of recording. Server-side equivalent on `PUT /entries/:id` for raw-HTTP clients.
- **Stale-check on read (background).** When an agent reads an entry whose verify is >7 days old, a re-check fires in the background and writes the result back. Natural agent usage becomes self-maintenance. Off by default for library callers; on in the MCP server. Disable with `NODUS_DISABLE_BACKGROUND_VERIFY=1`.

### Memory health surfaces

- **Brief health section.** `nodus-context://brief` opens with a `## Memory health` block listing failed verifies, never-checked entries, and possible duplicate clusters. Auto-loaded by MCP clients, so problems can't hide.
- **Healthline urgency split.** Headlines in the brief and `doctor --memory` separate urgent (failed) from informational (never-checked, stale, duplicates) so 12 issues is legible at a glance. Fresh installs (everything created in the last 24h) suppress never-checked from the brief — no onboarding nags.
- **Failed entries stay visible** in brief content sections with a ⚠ marker. Rules and preferences are load-bearing; a failed URL on a rule doesn't mean the rule no longer applies. Memory health flags the verify failure separately.
- **`acknowledge_health` MCP tool + ack store.** Each health issue carries a stable `key`. Agents call `acknowledge_health(keys[])` after mentioning issues; acks suppress the issue for 7 days. "Mention once per session" is now enforced.
- **Ack sync across devices.** HTTP backends expose `GET /acks` / `POST /acks`; mirror backends merge local + remote. An ack on the laptop suppresses the issue on the desktop. Falls back to local-only on older servers.
- **`context doctor --memory`** — on-demand human-readable audit; `--json` for AI assistants. `doctor --json` (without `--memory`) folds memory health inline so AI agents get profile + agents + store state in one call.
- **`GET /health` endpoint + `ContextBackend.health()`.** HttpBackend fetches a server-computed audit instead of pulling full entry lists. Mirror delegates to primary. Falls back to client-side computation when the server doesn't implement it.

### Escape hatches

- **`context accept <id> [--reason="..."]`** — silence a failed verify the user has confirmed is intentional ("yes, that repo was archived on purpose"). The entry stays put; it just stops appearing as a problem. Auto-clears if a later verify passes. Reverse with `--unaccept`. `accept_context` MCP tool exposes the same — agents are instructed never to accept without explicit user confirmation.
- **`context merge <from> <into>`** — combine two entries (the typical workflow after `doctor --memory` flags a duplicate cluster). Joins bodies, unions tags, links via `supersedes`, deletes `from`. `merge_context` MCP tool mirrors this.
- **Contradiction-aware relatedness.** `write_context` returns `relatedExisting[]` when the new content overlaps with entries at other ids, with a `relation` field (`same-subject` or `similar`) so agents know whether to supersede or accept the duplicate.

### CLI

- **Renamed to `context`.** The primary binary is now `context` (e.g. `context doctor`, `context add user/identity`). `nodus-context`, `nodus-context-mcp`, and `nodus-context-server` remain as backward-compat aliases — every existing install, MCP config, and shell-history command still works. New docs use `context`.
- **`context update`** — self-update command that detects how you installed (`npm`/`pnpm`/`yarn`/`brew`/`npx`) and runs the right command. `--check` just reports availability without installing; `--json` for scripts.
- **Update awareness.** Banner on long-running commands, line in `doctor`, brief surface in MCP. Disable with `NODUS_DISABLE_UPDATE_CHECK=1`.
- **`context verify --failed | --never | --stale`** — targeted re-checks so re-running after an audit doesn't re-verify the whole store. Combine selectors freely. `--force` includes accepted entries.
- **`context add/edit --verify=kind:target`** — attach a verify block without hand-editing YAML frontmatter. `edit --verify=…` alone (no body change) updates the verify block in place; `edit --clear-verify` removes it.

### Search

- **Local search is now BM25 lexical.** Replaces naive substring. Tolerates word order, supports prefix matching, weighs id/title/tags higher than body, ranks rarer terms higher. No setup, no dependencies, no model download.
- **Ollama-backed semantic search is now opt-in.** Lexical is the default and what the README recommends. Ollama remains supported via the same env vars for users who want vector search on the local backend.
- **HTTP/mirror backends delegate search to the server**, so server-side embeddings "just work" for paired users without client config.

### Protocol

- **HTTP**: `PUT /entries/:id` accepts `verify`, `verifiedAt`, `verifyStatus`, `verifyMessage`, `confirmations` fields. Server-side verify-on-write when the client sends a verify block without status. `GET /health` and `GET /acks` / `POST /acks` endpoints. Older servers that ignore unknown fields keep working.

### Other

- **Confirmations are deduped and capped per entry.** At most one confirmation per (agent, day); the last 12 are retained. Repeated `confirm_context` calls on the same entry no longer bloat frontmatter.
- **Verify timeout unified.** All verify call sites use a single resolver. `NODUS_VERIFY_TIMEOUT_MS` overrides the 8s default; inline verify-on-write caps at 3s regardless so writes stay fast.
- **Bounded brief content sections.** Rules/preferences/identity are capped at 8 entries per section, sorted by recency, with a "…and N more" pointer. Keeps the auto-loaded surface token-friendly.
- **`LocalBackend.flushBackgroundWork()`** for graceful shutdown and deterministic tests.
- **MCP server `instructions`** rewritten to teach the agent contract: use entries with confidence, call `confirm_context` near end-of-turn, revise existing entries instead of forking duplicates, mention health issues once per session without lecturing.

### Release hygiene

- `prepublishOnly` now runs `build:mcpb` — `npm publish` fails if the Claude Desktop bundle can't build, so the README's `releases/latest/.mcpb` link can't 404.
- `@anthropic-ai/mcpb` version pinned in `scripts/build-mcpb.mjs` so release output is reproducible.
- README adds a **Network use** section explicitly enumerating every outbound call the package makes (update check, verify blocks, http/mirror backend) and the env vars that disable each.
- `context update` recognizes Homebrew formula installs (Cellar paths) and the unknown-fallback now mentions `brew upgrade`.

## 0.0.13 — 2026-05-27

### Added
- LICENSE file (MIT) so GitHub and npm both detect the license.
- `prepublishOnly` script — builds and runs tests before every publish.
- Repository metadata in `package.json` (`repository`, `bugs`, `homepage`, `keywords`, `author`) so npm and GitHub render proper links.

### Fixed
- HTTP server hardened: stricter JSON limits, JSONC tolerance on config reads, author propagation through `revert`.
- `doctor` no longer prints spurious noise when a backend is healthy.
- Codex CLI detection no longer false-negatives.
- Restart wording is concrete per agent rather than "restart your agents".
- Custom MCP server icon is shipped in the `.mcpb` bundle so Claude Desktop renders the Nodus avatar.

## 0.0.12 — initial public release

- Local / HTTP / mirror backends with identical CLI surface.
- MCP server exposing `read_context`, `write_context`, `search_context`, `list_context`, `list_tags`, `delete_context`, plus `nodus-context://brief` resource.
- Author attribution (`author`, `createdBy`) tracked per entry.
- Auto-snapshot history with `revert` / `snapshot` commands.
- Pluggable embedders for semantic search (Ollama by default).
- `nodus-context-server install` + `nodus-context join <pairing-string>` for multi-device setup.
- mDNS auto-discovery on LAN.
- AI-friendly non-interactive `setup` command (see `AGENTS.md`).
- Optional Claude Desktop Extension (`.mcpb`) bundle for custom icon rendering.
