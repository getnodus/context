# Bugbot Rules — @getnodus/context

## Project context

TypeScript MCP server and CLI providing personal context/memory for AI agents.
Uses pnpm, targets Node 20/22/24, publishes to npm.

## Review priorities

- Memory store correctness: verify entries, dedup, merge, and confidence logic
- MCP tool surface: ensure tool schemas match documented contracts
- CLI flag handling: verify `--json` output shape and exit codes
- Backend behavior: local/server/mirror backends must stay consistent
- Type safety: no `any`, no `as` casts that hide real type issues

## Ignore

- Test file structure (tests are co-located with source)
- pnpm lockfile changes
- README/docs-only changes
