/**
 * Pairing strings — single-token URL-style codec that bundles the bits a
 * client needs to connect to a server: scheme, token, host, port.
 *
 * Shape: `nodus://<token>@<host>:<port>` (`scheme://userinfo@host:port`).
 * Tokens are URL-safe (hex, base64url) so they round-trip cleanly through
 * the userinfo position. If the server runs over HTTPS, encode it with
 * scheme `nodus+https://`. We assume `http` otherwise — Tailscale and
 * LANs rarely have TLS terminating on the server itself.
 *
 * Designed to be paste-able into a chat with an AI, or into the wizard
 * URL prompt — anywhere the user would otherwise type a URL.
 */

export interface Pairing {
  url: string
  token?: string
}

export function encodePairing(opts: { url: string; token?: string }): string {
  let parsed: URL
  try {
    parsed = new URL(opts.url)
  } catch {
    throw new Error(`invalid url: ${opts.url}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`pairing strings only support http(s) urls; got ${parsed.protocol}`)
  }
  const scheme = parsed.protocol === "https:" ? "nodus+https" : "nodus"
  const host = parsed.hostname
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  const userinfo = opts.token ? `${encodeURIComponent(opts.token)}@` : ""
  return `${scheme}://${userinfo}${bracketIfV6(host)}:${port}`
}

export function decodePairing(s: string): Pairing {
  const trimmed = s.trim()
  if (!trimmed.startsWith("nodus://") && !trimmed.startsWith("nodus+https://")) {
    throw new Error(`not a pairing string (expected nodus:// or nodus+https://): ${trimmed}`)
  }
  const isHttps = trimmed.startsWith("nodus+https://")
  // Swap our custom scheme for http(s) so URL can parse it.
  const asHttp = isHttps
    ? trimmed.replace(/^nodus\+https:\/\//, "https://")
    : trimmed.replace(/^nodus:\/\//, "http://")
  let parsed: URL
  try {
    parsed = new URL(asHttp)
  } catch {
    throw new Error(`malformed pairing string: ${trimmed}`)
  }
  if (!parsed.hostname) throw new Error(`pairing string missing host: ${trimmed}`)
  const token = parsed.username ? decodeURIComponent(parsed.username) : undefined
  // URL appends default ports as "" for http/80 and https/443. Re-include
  // the explicit port in the URL we hand back so clients always know
  // exactly where to connect.
  const port =
    parsed.port ||
    (parsed.protocol === "https:" ? "443" : "80")
  return {
    url: `${parsed.protocol}//${bracketIfV6(parsed.hostname)}:${port}`,
    ...(token ? { token } : {}),
  }
}

/** True if the string looks like a pairing string. Cheap prefix check. */
export function isPairingString(s: string): boolean {
  const t = s.trim()
  return t.startsWith("nodus://") || t.startsWith("nodus+https://")
}

/**
 * Redact the token from a pairing string for safe logging. The host/port
 * are preserved so operators can still see where to connect.
 */
export function redactPairingString(s: string): string {
  try {
    const decoded = decodePairing(s)
    if (!decoded.token) return s
    return encodePairing({ url: decoded.url, token: "redacted" })
  } catch {
    return s.replace(/^(nodus(?:\+https)?:\/\/)[^@]+@/, "$1redacted@")
  }
}

function bracketIfV6(host: string): string {
  // URL.hostname strips brackets from IPv6; we re-add them so the result
  // is a parseable URL.
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`
  return host
}
