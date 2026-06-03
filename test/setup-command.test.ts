import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalBackend } from "../src/backends/index.js"
import { loadConfig } from "../src/config/index.js"
import { encodePairing } from "../src/server/pairing.js"
import { startStubServer } from "./stub-server.js"

async function withIsolatedEnv<T>(fn: (dirs: { root: string; config: string; local: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nodus-setup-cmd-"))
  const prevConfig = process.env.NODUS_CONFIG_DIR
  const prevContext = process.env.NODUS_CONTEXT_DIR
  process.env.NODUS_CONFIG_DIR = join(root, "config")
  process.env.NODUS_CONTEXT_DIR = join(root, "local")
  try {
    return await fn({
      root,
      config: process.env.NODUS_CONFIG_DIR,
      local: process.env.NODUS_CONTEXT_DIR,
    })
  } finally {
    if (prevConfig === undefined) delete process.env.NODUS_CONFIG_DIR
    else process.env.NODUS_CONFIG_DIR = prevConfig
    if (prevContext === undefined) delete process.env.NODUS_CONTEXT_DIR
    else process.env.NODUS_CONTEXT_DIR = prevContext
    await rm(root, { recursive: true, force: true })
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["dist/cli/index.js", ...args],
      { cwd: process.cwd(), env },
      (error: any, stdout, stderr) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr })
      },
    )
  })
}

test("setup --backend=mirror reconciles existing local memory before activation", async () => {
  await withIsolatedEnv(async ({ root, config, local }) => {
    const localBackend = new LocalBackend({ rootDir: local })
    await localBackend.init()
    await localBackend.write({
      id: "preferences/editor",
      title: "Editor",
      body: "Use the local-first memory store.",
      type: "preference",
      tags: ["memory"],
    })

    const remoteBackend = new LocalBackend({ rootDir: join(root, "remote") })
    await remoteBackend.init()
    const server = await startStubServer(remoteBackend)
    try {
      const result = await runCli(
        ["setup", "--backend=mirror", "--url", server.url, "--agents=none", "--json"],
        { ...process.env, NODUS_CONFIG_DIR: config, NODUS_CONTEXT_DIR: local },
      )
      assert.equal(result.code, 0, result.stderr)
      const body = JSON.parse(result.stdout)
      assert.equal(body.ok, true)
      assert.equal(body.configured, true)
      assert.equal(body.profile.type, "mirror")
      assert.equal(body.initialSync.copied, 1)

      const copied = await remoteBackend.read("preferences/editor")
      assert.equal(copied.body, "Use the local-first memory store.")

      const configAfter = await loadConfig()
      assert.equal(configAfter.activeProfile, "cloud")
    } finally {
      await server.close()
    }
  })
})

test("setup --backend=mirror does not activate profile when the server rejects auth", async () => {
  await withIsolatedEnv(async ({ root, config, local }) => {
    const remoteBackend = new LocalBackend({ rootDir: join(root, "remote") })
    await remoteBackend.init()
    const server = await startStubServer(remoteBackend, { token: "expected-token" })
    try {
      const result = await runCli(
        ["setup", "--backend=mirror", "--url", server.url, "--token", "wrong-token", "--agents=none", "--json"],
        { ...process.env, NODUS_CONFIG_DIR: config, NODUS_CONTEXT_DIR: local },
      )
      assert.equal(result.code, 1)
      const body = JSON.parse(result.stdout)
      assert.equal(body.ok, false)
      assert.equal(body.configured, false)
      assert.equal(body.reachable, true)
      assert.match(body.error, /rejected/)

      const configAfter = await loadConfig()
      assert.equal(configAfter.activeProfile, "default")
      assert.deepEqual(configAfter.profiles.default, { type: "local" })
    } finally {
      await server.close()
    }
  })
})

test("connect creates a mirror profile and preserves existing local memory", async () => {
  await withIsolatedEnv(async ({ root, config, local }) => {
    const localBackend = new LocalBackend({ rootDir: local })
    await localBackend.init()
    await localBackend.write({
      id: "projects/context/product-direction",
      title: "Context Product Direction",
      body: "Shared memory should feel like memory, not MCP configuration.",
      type: "project-state",
      tags: ["context", "memory"],
    })

    const remoteBackend = new LocalBackend({ rootDir: join(root, "remote") })
    await remoteBackend.init()
    const server = await startStubServer(remoteBackend)
    try {
      const pairing = encodePairing({ url: server.url })
      const result = await runCli(
        ["connect", pairing, "--no-install", "--json"],
        { ...process.env, NODUS_CONFIG_DIR: config, NODUS_CONTEXT_DIR: local },
      )
      assert.equal(result.code, 0, result.stderr)
      const body = JSON.parse(result.stdout)
      assert.equal(body.ok, true)
      assert.equal(body.configured, true)
      assert.equal(body.type, "mirror")
      assert.equal(body.initialSync.copied, 1)

      const copied = await remoteBackend.read("projects/context/product-direction")
      assert.equal(copied.body, "Shared memory should feel like memory, not MCP configuration.")

      const configAfter = await loadConfig()
      assert.equal(configAfter.activeProfile, "cloud")
      assert.equal(configAfter.profiles.cloud.type, "mirror")
    } finally {
      await server.close()
    }
  })
})
