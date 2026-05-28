# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report privately via GitHub's [private vulnerability reporting](https://github.com/getnodus/context/security/advisories/new), or email `security@nodus.to`.

Include:

- A description of the issue and the impact you're concerned about.
- Steps to reproduce, ideally with a minimal proof-of-concept.
- Affected version (`context --version`) and platform.
- Whether you'd like to be credited in the advisory.

We aim to acknowledge new reports within 3 business days. Critical issues get a coordinated fix + advisory; lower-severity issues may be rolled into the next regular release.

## Supported versions

Only the latest minor release line of `@getnodus/context` receives security fixes. Older versions are best-effort.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## What's in scope

This package handles a few sensitive surfaces; please consider these when reviewing:

- **Bearer tokens** for the `http` and `mirror` backends, stored in `~/.nodus/config.json` (or `$NODUS_CONFIG_DIR/config.json`) under `profiles.<name>.token`.
- **Local memory store** at `~/.nodus/context/` (or `$NODUS_CONTEXT_DIR`) — plain markdown, no encryption at rest by design.
- **MCP server** spawned by AI agents (Claude Desktop, Cursor, etc.) — runs in-process with the agent.
- **HTTP server** (`context-server`) — optional, exposes the same protocol over the network; uses a single shared bearer token.
- **mDNS auto-discovery** on LAN — broadcasts the server's existence to the local network when enabled.
- **Update check** — outbound request to the npm registry; disable with `NODUS_DISABLE_UPDATE_CHECK=1`.
- **Verify blocks** — outbound requests to URLs/repos declared in entries; disable with `NODUS_DISABLE_BACKGROUND_VERIFY=1`.

See the [Network use](./README.md#network-use) section of the README for the full list of outbound calls and their env-var kill switches.

## What's out of scope

- **Misuse by agents** — an agent that an attacker controls can also exfiltrate the local memory. Threat model assumes the agent is trusted.
- **OS-level access** — anyone with read access to `~/.nodus/` can read your context. Protect your home directory with the usual OS mechanisms.
- **Self-hosted server deployments** — securing your own `context-server` install (TLS, network ACLs, token rotation) is your responsibility. The protocol is documented in [PROTOCOL.md](./PROTOCOL.md).
