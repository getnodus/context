# Releasing

Maintainer cheat sheet for cutting a release of `@getnodus/context`.

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit on `main`:
   ```sh
   git commit -am "release: vX.Y.Z"
   git push
   ```
3. Build, test, build the `.mcpb` bundle:
   ```sh
   pnpm test          # also builds
   pnpm build:mcpb    # writes dist/nodus-context-X.Y.Z.mcpb
   ```
4. Tag and push:
   ```sh
   git tag vX.Y.Z
   git push --tags
   ```
5. Publish to npm (`prepublishOnly` re-runs build + tests):
   ```sh
   npm publish
   ```
6. Create the GitHub release and attach the `.mcpb`:
   ```sh
   gh release create vX.Y.Z dist/nodus-context-X.Y.Z.mcpb \
     --title "vX.Y.Z" \
     --notes-from-tag
   ```

The README points at `releases/latest` for the Claude Desktop bundle, so **every release must attach the `.mcpb`** — otherwise that link 404s for users.
