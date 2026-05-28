# Changelog

All notable changes to `@getnodus/context` are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- **`context` CLI name.** The primary binary is now `context` (e.g. `context doctor`, `context add user/identity`). `nodus-context`, `nodus-context-mcp`, and `nodus-context-server` remain as backward-compat aliases — every existing install, MCP config, and shell-history command still works. New docs and AI-agent guidance use `context`.
- **`context accept <id> [--reason="..."]`** — escape hatch for failed verifies that are intentional ("yes, that repo was archived on purpose"). Marks the entry's current state as accepted so it stops appearing as a problem in the brief and `doctor --memory`. Auto-clears if a later verify passes. Reverse with `accept --unaccept`. New `accept_context` MCP tool exposes the same to agents — they're instructed never to accept without explicit user confirmation.
- **`context merge <from> <into>`** — combine two entries (typical workflow for `doctor --memory` duplicate clusters). Joins bodies, unions tags, links via `supersedes`, deletes `from`. New `merge_context` MCP tool exposes the same.
- **`context verify --failed | --never | --stale`** — targeted re-checks so re-running after an audit doesn't re-verify the whole store. Combine selectors freely. `--force` includes accepted entries.
- **`context add/edit --verify=kind:target`** — attach a verify block from the CLI without hand-editing YAML frontmatter. `edit --verify=…` alone (no body change) updates the verify block in place; `edit --clear-verify` removes it.
- **Ack sync across devices.** HTTP backends expose new `GET /acks` / `POST /acks` endpoints; mirror backends merge local + remote. An ack on the user's laptop suppresses the issue on their desktop. Falls back to local-only on older servers (404 is tolerated).
- **`NODUS_VERIFY_TIMEOUT_MS`** — override the 8s verify timeout. Inline verify-on-write keeps a hard 3s ceiling regardless so writes stay fast.
- **`NODUS_DISABLE_BACKGROUND_VERIFY=1`** — suppress stale-on-read background verifies (metered/offline use).
- Memory-health audit included inline in `doctor --json` (`memory` field). One call gives AI agents a full picture of profile + agents + store state; `doctor --memory --json` remains available for the per-entry deep view.

### Changed
- **Confidence is computed client-side when servers omit it.** HTTP backends now derive `confidence` from the returned entry's verify state when the server doesn't supply the field. The trust signal is uniform across local/http/mirror profiles.
- **Failed verifies stay visible in brief content sections** with a ⚠ marker instead of being hidden. Rules and preferences are load-bearing; a failed URL doesn't mean the rule no longer applies. Memory health flags the verify failure separately.
- **Healthline urgency split.** Brief and `doctor --memory` headlines separate urgent (failed) from informational (never-checked, stale, duplicates). On a fresh install (every entry created in the last 24h), never-checked is suppressed from the brief — no nagging during onboarding.
- **Confirmations are deduped and capped per entry.** Entries store at most one confirmation per (agent, day); the last 12 are retained. Repeated `confirm_context` calls on the same entry no longer bloat frontmatter.
- **Verify timeout unified.** All verify call sites use a single resolver (env-overrideable, 8s default). Inline verify-on-write opts in to a 3s ceiling via the new `inlineBudgetMs` option, replacing hard-coded `timeoutMs: 3000`.
- `doctor` prints an inline memory-health summary (clean/urgent/informational) so the user sees the store's state without running `--memory`.

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
