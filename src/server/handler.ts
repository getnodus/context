import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { ContextBackend } from "../backends/index.js"
import { MAX_BODY_BYTES } from "../backends/index.js"
import { packageVersion } from "../cli/version.js"

// Cap request bodies at 2× MAX_BODY_BYTES so the entry-size limit applies
// after JSON overhead. Anything beyond is rejected with 413 before reaching
// the backend.
const MAX_REQUEST_BYTES = MAX_BODY_BYTES * 2

// Reasonable upper bound for any list/search limit; protects against
// callers passing limit=999999999 to force a full table scan.
const MAX_LIMIT = 1000

export interface HandlerOptions {
  /** If set, requests must include `Authorization: Bearer <token>`. */
  token?: string
  /** Called once per completed request for access logging. */
  onRequest?: (info: {
    method: string
    path: string
    status: number
    durationMs: number
  }) => void
}

/**
 * Build a request handler that speaks the Nodus Context HTTP Protocol on
 * top of any ContextBackend. Used by both the production server bin and
 * the test stub server.
 */
export function createHandler(
  backend: ContextBackend,
  options: HandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const started = Date.now()
    const method = req.method ?? "GET"
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    let status = 200
    try {
      if (options.token) {
        const auth = req.headers["authorization"]
        if (!tokenMatches(auth, options.token)) {
          status = 401
          res.statusCode = 401
          res.end()
          return
        }
      }

      const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/")
      const desc = backend.describe()

      // GET / — protocol capabilities handshake (see PROTOCOL.md)
      if (method === "GET" && (url.pathname === "/" || segments[0] === "")) {
        status = 200
        sendJson(res, 200, {
          protocolVersion: 1,
          name: "@getnodus/context server",
          version: packageVersion(),
          backend: { type: desc.type, label: desc.label },
          capabilities: {
            history: desc.capabilities.history,
            semanticSearch: !!desc.capabilities.semanticSearch,
          },
        })
        return
      }

      // GET /entries
      if (method === "GET" && segments[0] === "entries" && segments.length === 1) {
        const prefix = url.searchParams.get("prefix") ?? undefined
        const tags = url.searchParams.getAll("tag")
        const types = url.searchParams.getAll("type")
        const authors = url.searchParams.getAll("author")
        const sort = url.searchParams.get("sort") as
          | "updated-desc"
          | "updated-asc"
          | "id-asc"
          | null
        const includeExpired = url.searchParams.has("includeExpired")
        const entries = await backend.list({
          prefix,
          tags: tags.length > 0 ? tags : undefined,
          type: types.length > 0 ? types : undefined,
          author: authors.length > 0 ? authors : undefined,
          ...(sort ? { sort } : {}),
          limit: parsePositiveInt(url.searchParams.get("limit")),
          includeExpired,
        })
        sendJson(res, 200, { entries })
        return
      }

      // GET /entries/:id  OR  GET /entries/:id/history/:snapshot
      if (
        method === "GET" &&
        segments[0] === "entries" &&
        segments.length >= 2 &&
        segments[segments.length - 1] !== "history"
      ) {
        if (segments[segments.length - 2] === "history") {
          const id = segments
            .slice(1, segments.length - 2)
            .map(decodeURIComponent)
            .join("/")
          const snapshotName = decodeURIComponent(segments[segments.length - 1])
          if (!backend.readSnapshot) {
            status = 404
            sendJson(res, 404, { error: "history not supported" })
            return
          }
          try {
            const snap = await backend.readSnapshot(id, snapshotName)
            sendJson(res, 200, snap)
          } catch {
            status = 404
            sendJson(res, 404, { error: "snapshot not found" })
          }
          return
        }
        const id = segments.slice(1).map(decodeURIComponent).join("/")
        try {
          const entry = await backend.read(id)
          sendJson(res, 200, entry)
        } catch {
          status = 404
          sendJson(res, 404, { error: "not found" })
        }
        return
      }

      // GET /entries/:id/history
      if (
        method === "GET" &&
        segments[0] === "entries" &&
        segments[segments.length - 1] === "history"
      ) {
        const id = segments.slice(1, -1).map(decodeURIComponent).join("/")
        if (!backend.listHistory) {
          status = 404
          sendJson(res, 404, { error: "history not supported" })
          return
        }
        const snapshots = await backend.listHistory(id)
        sendJson(res, 200, { snapshots })
        return
      }

      // PUT /entries/:id
      if (method === "PUT" && segments[0] === "entries" && segments.length >= 2) {
        const id = segments.slice(1).map(decodeURIComponent).join("/")
        const body = await readBody(req)
        if (body === TOO_LARGE) {
          status = 413
          sendJson(res, 413, { error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` })
          return
        }
        const parsed = body ? JSON.parse(body) : {}
        const entry = await backend.write({
          id,
          body: parsed.body,
          title: parsed.title,
          type: parsed.type,
          tags: parsed.tags,
          supersedes: parsed.supersedes,
          expires: parsed.expires,
          author: parsed.author,
        })
        sendJson(res, 200, entry)
        return
      }

      // DELETE /entries/:id
      if (method === "DELETE" && segments[0] === "entries" && segments.length >= 2) {
        const id = segments.slice(1).map(decodeURIComponent).join("/")
        try {
          await backend.delete(id)
          sendJson(res, 200, { deleted: true })
        } catch {
          status = 404
          sendJson(res, 404, { error: "not found" })
        }
        return
      }

      // POST /entries/:id/revert
      if (
        method === "POST" &&
        segments[0] === "entries" &&
        segments[segments.length - 1] === "revert"
      ) {
        const id = segments.slice(1, -1).map(decodeURIComponent).join("/")
        if (!backend.revert) {
          status = 404
          sendJson(res, 404, { error: "history not supported" })
          return
        }
        const body = await readBody(req)
        if (body === TOO_LARGE) {
          status = 413
          sendJson(res, 413, { error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` })
          return
        }
        const parsed = body ? JSON.parse(body) : {}
        const entry = await backend.revert(id, parsed.snapshot, parsed.author)
        sendJson(res, 200, entry)
        return
      }

      // GET /search?q=...
      if (method === "GET" && segments[0] === "search") {
        const q = url.searchParams.get("q") ?? ""
        const hits = await backend.search(q, {
          limit: parsePositiveInt(url.searchParams.get("limit")),
        })
        sendJson(res, 200, { hits })
        return
      }

      // GET /tags
      if (method === "GET" && segments[0] === "tags") {
        const tags = await backend.listTags()
        sendJson(res, 200, { tags })
        return
      }

      status = 404
      res.statusCode = 404
      res.end()
    } catch (e: any) {
      status = 500
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: e?.message ?? String(e) }))
    } finally {
      options.onRequest?.({
        method,
        path: url.pathname,
        status,
        durationMs: Date.now() - started,
      })
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

/**
 * Sentinel returned from `readBody` when the request exceeds
 * `MAX_REQUEST_BYTES`. Callers check `=== TOO_LARGE` and respond 413
 * before parsing.
 */
const TOO_LARGE = Symbol("request-body-too-large")

async function readBody(req: IncomingMessage): Promise<string | typeof TOO_LARGE> {
  const chunks: Buffer[] = []
  let total = 0
  let oversized = false
  // Once oversized, drain the rest of the body without buffering so the
  // client finishes its upload and sees our 413 response instead of an
  // ECONNRESET. Returning early from for-await would close the iterator
  // and leave a half-uploaded socket behind, which on Node 20/22 hangs
  // undici's fetch enough to wedge the test runner.
  for await (const chunk of req) {
    if (oversized) continue
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    total += buf.length
    if (total > MAX_REQUEST_BYTES) {
      oversized = true
      continue
    }
    chunks.push(buf)
  }
  if (oversized) return TOO_LARGE
  return Buffer.concat(chunks).toString("utf8")
}

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) return undefined
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(n, MAX_LIMIT)
}

function tokenMatches(headerValue: string | string[] | undefined, expected: string): boolean {
  if (typeof headerValue !== "string") return false
  const prefix = "Bearer "
  if (!headerValue.startsWith(prefix)) return false
  const provided = Buffer.from(headerValue.slice(prefix.length))
  const target = Buffer.from(expected)
  if (provided.length !== target.length) return false
  return timingSafeEqual(provided, target)
}
