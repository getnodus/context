# Changelog

All notable changes to `@getnodus/context` are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- **Self-maintaining memory.** Entries can declare a `verify:` block (`url`, `repo`, or `path`) and a new `confirm_context` MCP tool / `nodus-context verify` CLI runs the check and stamps `verifyStatus` + `verifiedAt`. Memory is never aged out — entries stay forever, but their trust signal updates.
- **Confidence on search results.** `search_context` hits now carry `confidence: low|medium|high`. Low confidence means "verify before relying on this", not "warn the user". Computed from verify status + freshness.
- **Cross-agent corroboration as a confidence signal.** Two or more *distinct* agents (or `cli` / `user` / `background-verify`) confirming the same entry within 30 days lifts confidence to `high` automatically.
- **Brief health section.** `nodus-context://brief` now opens with a `## Memory health` block listing failed verifies, never-checked entries, and possible duplicates — the only auto-loaded surface, so problems can no longer hide in metadata. Agents are instructed to mention them once per session and offer to clean up.
- **Verify-on-write.** `write_context` runs the verify spec inline (3s budget) when present, returns a `verifyWarning` in the response when the check fails. Catches "you just recorded a reference to something that's already broken" at the moment of recording.
- **Stale-check on read (background).** When an agent reads an entry whose verify is older than 7 days, a re-check fires in the background and writes the result back. Natural agent usage becomes self-maintenance. Enabled in the MCP server; off by default for library callers.
- **Contradiction-aware relatedness.** `relatedExisting[]` entries now carry a `relation` field (`same-subject` or `similar`) computed from id-prefix + tag overlap. Agents treat `same-subject` as a strong signal to supersede rather than fork.
- **`nodus-context doctor --memory`** — explicit on-demand audit of the store. Prints failed verifies, never-checked entries, stale verifies, and possible duplicate clusters. JSON mode for AI assistants.
- **Server-side verify-on-write.** HTTP server's `PUT /entries/:id` runs verify inline when the request has a verify block but no status. Pure-`http` users (CLI, raw HTTP clients) now get the same write-time check as MCP users.
- **`GET /health` endpoint + `ContextBackend.health()`** method. HttpBackend uses it to fetch a server-computed audit instead of pulling full entry lists. Mirror delegates to primary. Falls back to client-side computation if the server doesn't implement it.
- **`acknowledge_health` MCP tool + ack store.** Each health issue carries a stable `key`. Agents are instructed to call `acknowledge_health(keys[])` after mentioning issues; acked keys are suppressed from the brief for 7 days. "Mention once per session" is now enforced, not just convention. Acks stored at `~/.nodus/.cache/health-acks.json`.
- **Write-time relatedness hint.** `write_context` returns `relatedExisting[]` when the new content overlaps with entries at other ids, nudging agents to revise the existing entry rather than create a duplicate.
- New `Confirmation` log on entries (last 8 confirmations kept) — tracks who confirmed an entry and how (verify, use, or user reaffirmation).
- `nodus-context verify <id> | --all` CLI command. Re-checks entries with a verify block; updates frontmatter in place.
- `LocalBackend.flushBackgroundWork()` for graceful shutdown / deterministic tests.
- Updated MCP server `instructions` to teach the agent contract: use entries with confidence, call `confirm_context` near end-of-turn, revise existing entries instead of forking duplicates, mention health issues once per session without lecturing.

### Changed
- Brief is now bounded: each content section (rules/preferences/identity) is capped at 8 entries, sorted by recency, with a "…and N more" pointer to `list_context`. Keeps the auto-loaded surface token-friendly.
- Entries with `verifyStatus: "failed"` are hidden from brief content sections — they're surfaced under `## Memory health` instead, so they can't quietly be cited as fact.

### Changed
- Local search is now BM25-based lexical search instead of naive substring. Tolerates word order, prefix matches, weighs id/title/tags higher than body, and ranks rare terms above common ones. No setup, no dependencies, no model download.
- Ollama-backed semantic search is demoted to an optional opt-in. Lexical search is the default and is what the README recommends; Ollama remains supported via the same env vars for users who want vector search on the local backend.
- HTTP and mirror backends continue to delegate search to the server, so server-side embeddings "just work" for paired users without any client config.
- HTTP protocol: `PUT /entries/:id` now accepts `verify`, `verifiedAt`, `verifyStatus`, `verifyMessage`, `confirmations` fields. Older servers that ignore unknown fields keep working.

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
