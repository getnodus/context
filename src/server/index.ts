import { createServer, Server } from "node:http"
import { AddressInfo } from "node:net"
import { ContextBackend } from "../backends/index.js"
import { createHandler, HandlerOptions } from "./handler.js"

export { createHandler, type HandlerOptions } from "./handler.js"

export interface StartServerOptions extends HandlerOptions {
  /** Port to bind. Use 0 to pick a free port. Default 7475. */
  port?: number
  /** Address to bind. Default "127.0.0.1"; use "0.0.0.0" to expose. */
  host?: string
}

export interface RunningServer {
  /** Base URL the server listens on, no trailing slash. */
  url: string
  /** Underlying node http server, for tests that need direct access. */
  server: Server
  close(): Promise<void>
}

/**
 * Start an HTTP server speaking the Nodus Context Protocol on top of the
 * given backend. Returns a handle with the bound URL and a close function.
 *
 * Bind defaults to 127.0.0.1 — exposing the server publicly is opt-in via
 * `host: "0.0.0.0"`. Pair with `token` whenever you bind to a non-loopback
 * address.
 */
export async function startServer(
  backend: ContextBackend,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const port = options.port ?? 7475
  const host = options.host ?? "127.0.0.1"
  const handler = createHandler(backend, options)
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      try {
        res.statusCode = 500
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ error: "internal server error" }))
      } catch {}
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const addr = server.address() as AddressInfo
  // Display loopback as 127.0.0.1 even when bound to ::1, and 0.0.0.0 as
  // the actual bind host so users can see what's exposed.
  const displayHost = addr.address === "::" ? "0.0.0.0" : addr.address === "::1" ? "127.0.0.1" : addr.address
  return {
    server,
    url: `http://${displayHost}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}
