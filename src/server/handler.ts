import type { IncomingMessage, ServerResponse } from "node:http"
import type { ContextBackend } from "../backends/index.js"
import { packageVersion } from "../cli/version.js"

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
        if (auth !== `Bearer ${options.token}`) {
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
        const limit = url.searchParams.get("limit")
        const includeExpired = url.searchParams.has("includeExpired")
        const entries = await backend.list({
          prefix,
          tags: tags.length > 0 ? tags : undefined,
          type: types.length > 0 ? types : undefined,
          author: authors.length > 0 ? authors : undefined,
          ...(sort ? { sort } : {}),
          limit: limit ? parseInt(limit, 10) : undefined,
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
        const parsed = body ? JSON.parse(body) : {}
        const entry = await backend.revert(id, parsed.snapshot)
        sendJson(res, 200, entry)
        return
      }

      // GET /search?q=...
      if (method === "GET" && segments[0] === "search") {
        const q = url.searchParams.get("q") ?? ""
        const limit = url.searchParams.get("limit")
        const hits = await backend.search(q, {
          limit: limit ? parseInt(limit, 10) : undefined,
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}
