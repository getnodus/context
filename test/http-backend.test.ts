import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpBackend, LocalBackend, BackendError } from "../src/backends/index.js"
import { startStubServer } from "./stub-server.js"
import { runConformance } from "./conformance.js"

async function setupHttp() {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-http-"))
  const local = new LocalBackend({ rootDir: dir })
  await local.init()
  const server = await startStubServer(local)
  const backend = new HttpBackend({ url: server.url })
  return {
    backend,
    cleanup: async () => {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

runConformance("http", setupHttp)

test("[http] describe reports correct type", async () => {
  const { backend, cleanup } = await setupHttp()
  try {
    const d = backend.describe()
    assert.equal(d.type, "http")
  } finally {
    await cleanup()
  }
})

test("[http] history methods proxy through stub", async () => {
  const { backend, cleanup } = await setupHttp()
  try {
    await backend.write({ id: "user/identity", body: "v1" })
    await new Promise((r) => setTimeout(r, 10))
    await backend.write({ id: "user/identity", body: "v2" })

    const history = await backend.listHistory!("user/identity")
    assert.equal(history.length, 1)

    const reverted = await backend.revert!("user/identity")
    assert.equal(reverted.body, "v1")
  } finally {
    await cleanup()
  }
})

test("[http] bearer token auth is enforced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-auth-"))
  const local = new LocalBackend({ rootDir: dir })
  await local.init()
  const server = await startStubServer(local, { token: "secret-123" })
  try {
    const wrongToken = new HttpBackend({ url: server.url, token: "wrong" })
    await assert.rejects(() => wrongToken.list(), /rejected/)

    const rightToken = new HttpBackend({ url: server.url, token: "secret-123" })
    const list = await rightToken.list()
    assert.deepEqual(list, [])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("[http] surfaces server timeout as BackendError", async () => {
  // Server that never responds
  const { createServer } = await import("node:http")
  const slow = createServer(() => {
    /* never respond */
  })
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r))
  const addr = slow.address() as import("node:net").AddressInfo
  try {
    const backend = new HttpBackend({ url: `http://127.0.0.1:${addr.port}`, timeoutMs: 100 })
    await assert.rejects(() => backend.list(), BackendError)
  } finally {
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  }
})
