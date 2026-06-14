import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  normalizeConfig,
  configPath,
  getActiveProfile,
  redactConfig,
  CONFIG_FILE_MODE,
} from "../src/config/index.js"

async function withConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nodus-ctx-cfg-"))
  const prev = process.env.NODUS_CONFIG_DIR
  process.env.NODUS_CONFIG_DIR = dir
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.NODUS_CONFIG_DIR
    else process.env.NODUS_CONFIG_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
}

test("loadConfig returns default when no file exists", async () => {
  await withConfigDir(async () => {
    const config = await loadConfig()
    assert.equal(config.activeProfile, "default")
    assert.deepEqual(config.profiles.default, { type: "local" })
  })
})

test("saveConfig + loadConfig round-trips", async () => {
  await withConfigDir(async () => {
    const before = {
      activeProfile: "server",
      profiles: {
        default: { type: "local" as const },
        server: { type: "http" as const, url: "https://example.com", token: "abc" },
      },
    }
    await saveConfig(before)
    const after = await loadConfig()
    assert.deepEqual(after, before)
  })
})

test("getActiveProfile resolves the right profile", async () => {
  await withConfigDir(async () => {
    await saveConfig({
      activeProfile: "server",
      profiles: {
        default: { type: "local" },
        server: { type: "http", url: "https://example.com" },
      },
    })
    const { name, profile } = await getActiveProfile()
    assert.equal(name, "server")
    assert.equal(profile.type, "http")
  })
})

test("normalizeConfig fixes missing active profile", () => {
  const config = normalizeConfig({
    activeProfile: "nonexistent",
    profiles: { local: { type: "local" } },
  })
  assert.equal(config.activeProfile, "local")
})

test("normalizeConfig adds default when no profiles", () => {
  const config = normalizeConfig({})
  assert.equal(config.activeProfile, "default")
  assert.deepEqual(config.profiles.default, { type: "local" })
})

test("saveConfig writes config.json with mode 600", async () => {
  await withConfigDir(async () => {
    await saveConfig(defaultConfig())
    const st = await stat(configPath())
    assert.equal(st.mode & 0o777, CONFIG_FILE_MODE)
  })
})

test("redactConfig replaces bearer tokens in json output", () => {
  const config = {
    activeProfile: "cloud",
    profiles: {
      default: { type: "local" as const },
      cloud: {
        type: "mirror" as const,
        primary: { type: "local" as const },
        secondary: { type: "http" as const, url: "http://10.0.0.1:7475", token: "secret-abc" },
      },
    },
  }
  const redacted = redactConfig(config)
  assert.equal(redacted.profiles.cloud.type, "mirror")
  if (redacted.profiles.cloud.type === "mirror") {
    assert.equal(redacted.profiles.cloud.secondary.type, "http")
    if (redacted.profiles.cloud.secondary.type === "http") {
      assert.equal(redacted.profiles.cloud.secondary.token, "<redacted>")
    }
  }
})

test("redactConfig redacts http headers in json output", () => {
  const config = {
    activeProfile: "server",
    profiles: {
      server: {
        type: "http" as const,
        url: "https://example.com",
        headers: {
          authorization: "Basic secret",
          "x-api-key": "key",
        },
      },
    },
  }
  const redacted = redactConfig(config)
  assert.equal(redacted.profiles.server.type, "http")
  if (redacted.profiles.server.type === "http") {
    assert.deepEqual(redacted.profiles.server.headers, {
      authorization: "<redacted>",
      "x-api-key": "<redacted>",
    })
  }
})

test("configPath honors NODUS_CONFIG_DIR", async () => {
  await withConfigDir(async () => {
    const p = configPath()
    assert.match(p, /config\.json$/)
    assert.ok(p.startsWith(process.env.NODUS_CONFIG_DIR!))
  })
})
