import test from "node:test"
import assert from "node:assert/strict"
import { isPrivateIp, isPrivateUrl, runVerify } from "../src/backends/verify.js"

test("isPrivateUrl blocks loopback and RFC1918 literals", () => {
  assert.equal(isPrivateUrl("http://127.0.0.1/"), true)
  assert.equal(isPrivateUrl("http://localhost/"), true)
  assert.equal(isPrivateUrl("http://10.0.0.1/"), true)
  assert.equal(isPrivateUrl("http://192.168.1.1/"), true)
  assert.equal(isPrivateUrl("http://169.254.169.254/"), true)
  assert.equal(isPrivateUrl("http://[::1]/"), true)
  assert.equal(isPrivateUrl("http://[fe80::1]/"), true)
  assert.equal(isPrivateUrl("http://[fc00::1]/"), true)
  assert.equal(isPrivateUrl("http://[::ffff:127.0.0.1]/"), true)
})

test("isPrivateUrl allows public hosts", () => {
  assert.equal(isPrivateUrl("https://example.com/path"), false)
  assert.equal(isPrivateUrl("https://api.github.com/repos/o/r"), false)
})

test("isPrivateIp covers CGNAT range", () => {
  assert.equal(isPrivateIp("100.64.0.1"), true)
  assert.equal(isPrivateIp("8.8.8.8"), false)
})

test("isPrivateIp covers IPv4-mapped IPv6 addresses", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true)
  assert.equal(isPrivateIp("::ffff:7f00:1"), true)
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false)
})

test("verify url: rejects private literal without fetching", async () => {
  let called = false
  const fakeFetch = (async () => {
    called = true
    return { ok: true, status: 200 } as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "http://127.0.0.1/admin" },
    { fetch: fakeFetch },
  )
  assert.equal(result.status, "failed")
  assert.match(result.message ?? "", /private\/internal/)
  assert.equal(called, false)
})

test("verify url: rejects redirect to private address", async () => {
  const fakeFetch = (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url === "https://example.com/start") {
      return {
        status: 302,
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? "http://127.0.0.1/secret" : null) },
        body: { cancel: async () => {} },
      } as unknown as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "https://example.com/start" },
    {
      fetch: fakeFetch,
      lookup: async () => ({ address: "93.184.216.34" }),
    },
  )
  assert.equal(result.status, "failed")
  assert.match(result.message ?? "", /private\/internal/)
})

test("verify url: rejects hostname resolving to private IP", async () => {
  let called = false
  const fakeFetch = (async () => {
    called = true
    return { ok: true, status: 200 } as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "https://evil.example/start" },
    {
      fetch: fakeFetch,
      lookup: async () => ({ address: "127.0.0.1" }),
    },
  )
  assert.equal(result.status, "failed")
  assert.match(result.message ?? "", /resolves to a private/)
  assert.equal(called, false)
})

test("verify url: rejects hostname when any DNS answer is private", async () => {
  let called = false
  const fakeFetch = (async () => {
    called = true
    return { ok: true, status: 200 } as Response
  }) as typeof fetch

  const result = await runVerify(
    { kind: "url", target: "https://mixed.example/start" },
    {
      fetch: fakeFetch,
      lookup: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }],
    },
  )
  assert.equal(result.status, "failed")
  assert.match(result.message ?? "", /resolves to a private/)
  assert.equal(called, false)
})

test("verify url: DNS failure is unknown, not failed", async () => {
  const result = await runVerify(
    { kind: "url", target: "https://missing.example/" },
    {
      fetch: (async () => ({ ok: true, status: 200 })) as typeof fetch,
      lookup: async () => {
        throw new Error("ENOTFOUND")
      },
    },
  )
  assert.equal(result.status, "unknown")
  assert.match(result.message ?? "", /DNS lookup failed/)
})
