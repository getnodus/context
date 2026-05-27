import { createServer, Server } from "node:http"
import { AddressInfo } from "node:net"
import { ContextBackend } from "../src/backends/index.js"

/**
 * Reference implementation of the Nodus Context HTTP protocol, backed by
 * any ContextBackend (typically LocalBackend in tests). Used to verify
 * that HttpBackend speaks the protocol correctly.
 */
export async function startStubServer(
  backend: ContextBackend,
  options: { token?: string } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    try {
      if (options.token) {
        const auth = req.headers["authorization"]
        if (auth !== `Bearer ${options.token}`) {
          res.statusCode = 401
          res.end()
          return
        }
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
      const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/")
      const method = req.method ?? "GET"

      // GET /entries
      if (method === "GET" && segments[0] === "entries" && segments.length === 1) {
        const prefix = url.searchParams.get("prefix") ?? undefined
        const tags = url.searchParams.getAll("tag")
        const types = url.searchParams.getAll("type")
        const authors = url.searchParams.getAll("author")
        const limit = url.searchParams.get("limit")
        const includeExpired = url.searchParams.has("includeExpired")
        const entries = await backend.list({
          prefix,
          tags: tags.length > 0 ? tags : undefined,
          type: types.length > 0 ? types : undefined,
          author: authors.length > 0 ? authors : undefined,
          limit: limit ? parseInt(limit, 10) : undefined,
          includeExpired,
        })
        return json(res, 200, { entries })
      }

      // GET /entries/:id (any depth)
      if (method === "GET" && segments[0] === "entries" && segments.length >= 2 && segments[segments.length - 1] !== "history") {
        if (segments[segments.length - 2] === "history") {
          const id = segments.slice(1, segments.length - 2).map(decodeURIComponent).join("/")
          const snapshotName = decodeURIComponent(segments[segments.length - 1])
          try {
            const snap = await backend.readSnapshot!(id, snapshotName)
            return json(res, 200, snap)
          } catch {
            return json(res, 404, { error: "snapshot not found" })
          }
        }
        const id = segments.slice(1).map(decodeURIComponent).join("/")
        try {
          const entry = await backend.read(id)
          return json(res, 200, entry)
        } catch {
          return json(res, 404, { error: "not found" })
        }
      }

      // GET /entries/:id/history
      if (method === "GET" && segments[0] === "entries" && segments[segments.length - 1] === "history") {
        const id = segments.slice(1, -1).map(decodeURIComponent).join("/")
        const snapshots = await backend.listHistory!(id)
        return json(res, 200, { snapshots })
      }

      // PUT /entries/:id
      if (method === "PUT" && segments[0] === "entries" && segments.length >= 2) {
        const id = segments.slice(1).map(decodeURIComponent).join("/")
        const body = await readBody(req)
        const parsed = JSON.parse(body)
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
        return json(res, 200, entry)
      }

      // DELETE /entries/:id
      if (method === "DELETE" && segments[0] === "entries" && segments.length >= 2) {
        const id = segments.slice(1).map(decodeURIComponent).join("/")
        try {
          await backend.delete(id)
          return json(res, 200, { deleted: true })
        } catch {
          return json(res, 404, { error: "not found" })
        }
      }

      // POST /entries/:id/revert
      if (method === "POST" && segments[0] === "entries" && segments[segments.length - 1] === "revert") {
        const id = segments.slice(1, -1).map(decodeURIComponent).join("/")
        const body = await readBody(req)
        const parsed = body ? JSON.parse(body) : {}
        const entry = await backend.revert!(id, parsed.snapshot)
        return json(res, 200, entry)
      }

      // GET /search?q=...
      if (method === "GET" && segments[0] === "search") {
        const q = url.searchParams.get("q") ?? ""
        const limit = url.searchParams.get("limit")
        const hits = await backend.search(q, {
          limit: limit ? parseInt(limit, 10) : undefined,
        })
        return json(res, 200, { hits })
      }

      // GET /tags
      if (method === "GET" && segments[0] === "tags") {
        const tags = await backend.listTags()
        return json(res, 200, { tags })
      }

      res.statusCode = 404
      res.end()
    } catch (e: any) {
      res.statusCode = 500
      res.end(e?.message ?? String(e))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}`

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}
