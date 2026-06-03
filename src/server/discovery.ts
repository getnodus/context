// bonjour-service is a CommonJS module; under ESM, its named exports live
// on the default. Importing the namespace and grabbing .default.Bonjour
// works under both `tsc`'s module=NodeNext and at runtime in Node.
import bonjourPkg from "bonjour-service"
import { hostname } from "node:os"

const { Bonjour } = bonjourPkg as unknown as { Bonjour: new () => Bonjour }
type Bonjour = {
  publish(opts: { name: string; type: string; port: number; txt?: unknown }): MdnsService
  find(opts: { type: string }, onUp: (service: MdnsService) => void): MdnsService
  destroy(cb: () => void): void
}

// bonjour-service exports `Service` as a value (class) and types its
// `stop` member as the broad `CallableFunction`, which doesn't satisfy
// any narrower signature we'd write. We accept the service as `any`
// internally and narrow at the read sites.
type MdnsService = any  // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * mDNS service name. Conventional `_<name>._tcp.local` shape so any
 * standard Bonjour/Avahi browser can find us too.
 */
export const SERVICE_TYPE = "context"

export interface AdvertiseOptions {
  /** Display name. Defaults to the OS hostname. */
  name?: string
  /** Port the HTTP server is listening on. */
  port: number
  /** TXT record metadata. Visible to discoverers. */
  txt?: Record<string, string>
}

export interface AdvertiseHandle {
  stop(): Promise<void>
}

/**
 * Advertise the running server over mDNS so other devices on the same
 * physical LAN can auto-discover it. No-op if mDNS isn't reachable
 * (some sandboxed environments block multicast) — failure here must
 * never crash the server.
 *
 * Discovery is LAN-only. Tailscale and other overlay networks do not
 * forward mDNS multicast by default, so cross-tailnet devices won't see
 * each other; users on those should fall back to manual URL entry in
 * the wizard.
 */
export function startAdvertising(options: AdvertiseOptions): AdvertiseHandle {
  const bonjour = new Bonjour()
  const name = options.name ?? `context @ ${hostname()}`
  let service: MdnsService | undefined
  try {
    service = bonjour.publish({
      name,
      type: SERVICE_TYPE,
      port: options.port,
      txt: options.txt ?? {},
    })
  } catch {
    // multicast bind failed; just no advertisement.
  }
  return {
    stop: async () => {
      try {
        service?.stop?.(() => {})
      } catch {}
      try {
        await new Promise<void>((resolve) => bonjour.destroy(() => resolve()))
      } catch {}
    },
  }
}

export interface DiscoveredServer {
  /** Friendly name set by the server (defaults to hostname). */
  name: string
  /** Best-effort URL (`http://<host>:<port>`). Host may be a `.local` name. */
  url: string
  /** Raw addresses (IPv4 + IPv6 if available). */
  addresses: string[]
  port: number
  /** Decoded TXT record (version, protocol, backend label, etc.). */
  txt: Record<string, string>
}

export interface BrowseOptions {
  /** How long to wait for responses, in ms. Default 3000. */
  timeoutMs?: number
}

/**
 * Scan the local network for advertised context servers.
 * Resolves after `timeoutMs` with everything seen. Best-effort —
 * an empty array on a network without multicast is a normal outcome.
 */
export async function discover(options: BrowseOptions = {}): Promise<DiscoveredServer[]> {
  const timeout = options.timeoutMs ?? 3000
  const bonjour = new Bonjour()
  const found = new Map<string, DiscoveredServer>()
  try {
    const browser = bonjour.find({ type: SERVICE_TYPE }, (service: MdnsService) => {
      const url = serviceUrl(service)
      if (!url) return
      // Dedupe on URL; mDNS often emits multiple records per service.
      if (found.has(url)) return
      found.set(url, {
        name: service.name,
        url,
        addresses: (service.addresses ?? []) as string[],
        port: service.port,
        txt: normaliseTxt(service.txt),
      })
    })
    await new Promise<void>((resolve) => setTimeout(resolve, timeout))
    try {
      browser.stop?.()
    } catch {}
  } finally {
    await new Promise<void>((resolve) => bonjour.destroy(() => resolve()))
  }
  return Array.from(found.values())
}

function serviceUrl(s: MdnsService): string | undefined {
  // Prefer a numeric address — `.local` host names need MDNS resolution
  // at use time which not every consumer (e.g. curl on a Linux box
  // without nss-mdns) can do. IPv4 first since most home routers still
  // hate v6.
  const addrs = (s.addresses ?? []) as string[]
  const v4 = addrs.find((a) => a.includes(".") && !a.includes(":"))
  const v6 = addrs.find((a) => a.includes(":"))
  const host = v4 ?? v6
  if (!host) return undefined
  // Bracket v6 in the URL.
  const hostPart = v6 && host === v6 ? `[${host}]` : host
  return `http://${hostPart}:${s.port}`
}

function normaliseTxt(txt: unknown): Record<string, string> {
  if (!txt || typeof txt !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(txt as Record<string, unknown>)) {
    if (v == null) continue
    out[k] = Buffer.isBuffer(v) ? v.toString("utf8") : String(v)
  }
  return out
}
