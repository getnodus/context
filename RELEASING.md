# Releasing

Maintainer cheat sheet for cutting a release of `@getnodus/context`.

## How it actually ships

npm publishing runs from CI under **npm Trusted Publishers** (OIDC) — there is no `NPM_TOKEN` to rotate. The chain of events for a normal release is:

1. PR bumps `version` in `package.json` and updates `CHANGELOG.md` → merge to `main`.
2. Maintainer pushes a matching `vX.Y.Z` tag.
3. `.github/workflows/release.yml` fires on `tags: ['v*']`:
   - `pnpm install --frozen-lockfile`
   - `npm publish --provenance --access public` — the `prepublishOnly` hook (`pnpm build && pnpm test && pnpm build:mcpb`) runs the gates, then npm publishes via OIDC.
   - `gh release create vX.Y.Z ...` attaches the `.mcpb` and links a discussion in **Announcements**.

The tag push is the maintainer-controlled gate. Contributors bumping `package.json` in a PR does **not** trigger a release on its own.

## Step-by-step

1. **Open the release PR.**
   - Bump `version` in `package.json`.
   - Move the contents of the **Unreleased** section in `CHANGELOG.md` under a new `## X.Y.Z — YYYY-MM-DD` heading; leave a fresh empty `Unreleased` stub behind.
   - Title the PR `release: vX.Y.Z`.
   - Get it reviewed (`package.json` and `CHANGELOG.md` are CODEOWNER-gated).

2. **Merge to `main`.**

3. **Tag and push.** From a clean checkout of `main`:
   ```sh
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   The tag push triggers `release.yml`. Watch it in the Actions tab.

4. **Verify.** After the workflow goes green:
   - `npm view @getnodus/context version` returns `X.Y.Z`.
   - https://github.com/getnodus/context/releases/tag/vX.Y.Z shows the release with `nodus-context-X.Y.Z.mcpb` attached and a linked Announcement discussion.

The README points at `releases/latest` for the Claude Desktop bundle, so **every release must attach the `.mcpb`** — otherwise that link 404s for users. The workflow handles this; the failure mode to watch for is the `gh release create` step erroring out (commonly: missing `discussions: write` permission, or the Announcements category not existing yet).

## Local dry-run

Before tagging, you can reproduce what CI will do:

```sh
pnpm install --frozen-lockfile
pnpm test          # also builds
pnpm build:mcpb    # writes dist/nodus-context-X.Y.Z.mcpb
```

Do **not** run `npm publish` locally — Trusted Publishers expects the publish to come from the GitHub Actions OIDC context, so a local publish would either fail or require a personal token that we don't want floating around. If you genuinely need to bypass CI (broken Actions, npm outage), use a short-lived **Automation** token scoped to `@getnodus/context` and revoke it immediately afterward.

## Recovering from a failed release

The tag has already shipped but CI failed. Common causes and fixes:

- **`npm publish` failed.** Read the run log. If it's a transient registry issue, push the tag to a new ref to force a re-run:
  ```sh
  git push origin :refs/tags/vX.Y.Z   # delete remote tag (allowed by tag protection)
  git push origin vX.Y.Z              # re-push, retriggers release.yml
  ```
  If the *underlying code* needs a fix, bump to `vX.Y.Z+1` and start over — never re-tag the same version with different code.

- **`gh release create` failed** (e.g. discussion permission). The package is already on npm at that point. Create the release manually:
  ```sh
  gh release create vX.Y.Z dist/nodus-context-X.Y.Z.mcpb \
    --title "vX.Y.Z" \
    --notes-from-tag \
    --discussion-category Announcements
  ```

## Repo settings the workflows depend on

These live in GitHub settings, not in code — memorialized here so they don't get silently changed:

- **Tag protection rule** for pattern `v*` — only maintainers may create/move tags matching `v*`. This is the single highest-value control: it gates whether *anything* gets published.
- **Branch protection on `main`** — required status check: CI / test on Ubuntu+macOS for Node 20, 22, 24. Require PR review. Require linear history (no merge commits) is nice-to-have.
- **npm Trusted Publisher** for `@getnodus/context` (configured at https://www.npmjs.com/package/@getnodus/context/access):
  - Publisher: GitHub Actions
  - Org: `getnodus`, Repo: `context`, Workflow filename: `release.yml`
  - Environment: blank (add `npm-release` later if you want a manual-approval gate).
- **Announcements discussion category** must exist (used by `gh release create --discussion-category`).
- **`NPM_TOKEN` secret should NOT exist** — Trusted Publishers makes it unnecessary, and leaving an unused token around is a needless surface.
