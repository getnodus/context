# Contributing

Thanks for taking a look. Issues and PRs are welcome.

## Dev setup

```sh
pnpm install
pnpm build          # tsc
pnpm test           # build + node --test
pnpm typecheck      # tsc --noEmit
```

Node 20+ is required (`engines.node` in `package.json`).

## Running the CLI locally

```sh
pnpm build
node dist/cli/index.js doctor
```

Or link it into your `$PATH`:

```sh
pnpm build
npm link            # exposes nodus-context, nodus-context-mcp, nodus-context-server
```

## Running the MCP server against a real client

After `npm link`, point your MCP client at `nodus-context-mcp` (the binary from this checkout). Or use the non-interactive `setup` flow:

```sh
node dist/cli/index.js setup --backend=local --agents=detected --json
```

## Backends

The `ContextBackend` interface is the boundary. New backends live in `src/backends/`. Each backend is covered by the conformance suite in `test/conformance.ts` — wire your backend in there before adding ad-hoc tests.

## Tests

- `test/local-backend.test.ts`, `test/http-backend.test.ts`, `test/mirror-backend.test.ts` — backend conformance.
- `test/registry.test.ts`, `test/integrations.test.ts` — agent registration / MCP install.
- `test/semantic.test.ts` — embedding pipeline with a stub embedder.
- `test/stub-server.ts` — in-process HTTP server used by HTTP/mirror tests.

Tests run against compiled output (`pnpm build` then `node --test`), so always rebuild after edits.

## Releasing

Maintainers only. See `RELEASING.md`.
