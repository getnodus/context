# Contributing

Thanks for taking a look. Issues and PRs are welcome.

## Where to start

If you're not sure what to pick up:

- **Add a new agent integration.** The most common first PR. See *Adding a new agent* below.
- **Add a new backend.** Bigger but well-scoped. See *Adding a new backend* below.
- **Browse [open issues](https://github.com/getnodus/context/issues)**. Issues labeled `good first issue` or `help wanted` are explicitly marked.

Before you start anything non-trivial, open or comment on an issue — saves you from finishing something that has already been started, or that conflicts with a design call we'd want to discuss first.

## Branching, commits, PRs

- Branch off `main`; small, focused branches beat omnibus PRs.
- Commits follow the pattern `<area>: <imperative summary>` (`agents: add Foo client`, `mcp: tighten verify timeout`). Match what's in `git log`.
- Every PR needs:
  - Tests (or a one-line note for doc-only / config-only changes).
  - A `CHANGELOG.md` entry under the **Unreleased** heading. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
  - `pnpm typecheck && pnpm test` green locally.
- The repo runs CI on Ubuntu + macOS for Node 20, 22, 24. If a test is platform-specific, gate it explicitly rather than letting one OS go red.

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

Tests run against the TypeScript sources via `tsx` (see the `test` script in `package.json`). `pnpm test` does a `pnpm build` first so the type errors surface, then runs `node --import tsx --test test/*.test.ts` against `src/`. You don't need to rebuild between edits — just re-run `pnpm test`.

## Adding a new agent

Most MCP clients are a one-entry addition to the registry. Walk-through:

1. Open `src/cli/agents/built-in.ts`. Each entry sets:
   - `id`, `name`, `configPathHint` (where the config file lives, with `~` expansion).
   - `detect` — heuristics that tell `doctor` whether the agent is installed.
   - `install` — usually `{ kind: "json-merge", file: <path>, key: "mcpServers" }`. Some clients use `context_servers` (Zed) or a non-standard entry shape (OpenCode); see existing entries.
2. Add a test case in `test/registry.test.ts` covering at least `detect` (true and false) and the install-merge round-trip.
3. Update `README.md` if the agent needs a special restart instruction.
4. Update the CHANGELOG under *Unreleased* → *Agent registry*.

Look at the v0.1.1 commit `agents: add 6 new clients` (commit `5da10be`) for a reference diff.

## Adding a new backend

Backends live in `src/backends/`. The `ContextBackend` interface in `src/backends/types.ts` is the boundary — implement it and you're done.

1. Create `src/backends/<name>.ts` exporting a class that implements `ContextBackend`.
2. Wire it into the factory at `src/backends/factory.ts` so a `profiles.<name>.type === "<name>"` config resolves to your class.
3. Add it to the conformance suite: create `test/<name>-backend.test.ts` that imports `runConformance` from `./conformance.js` and calls it with a setup factory returning `{ backend, cleanup }` (in a temp dir if it touches disk). See `test/local-backend.test.ts` and `test/http-backend.test.ts` for the pattern. Don't write ad-hoc tests until the conformance suite is green.
4. Document the backend in `README.md` under *Backends*, including any config keys and env vars it understands.
5. If it makes outbound network calls, add it to *Network use* in README and *What's in scope* in `SECURITY.md`.

## Releasing

Maintainers only. See `RELEASING.md`.
