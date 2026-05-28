# Changelog

All notable changes to `@getnodus/context` are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
