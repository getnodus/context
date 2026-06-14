import test from "node:test"
import assert from "node:assert/strict"
import { decodePairing, encodePairing, isPairingString, redactPairingString } from "../src/server/pairing.js"

test("pairing round-trips http with token", () => {
  const s = encodePairing({ url: "http://192.168.1.20:7475", token: "abc123" })
  assert.equal(s, "nodus://abc123@192.168.1.20:7475")
  const decoded = decodePairing(s)
  assert.equal(decoded.url, "http://192.168.1.20:7475")
  assert.equal(decoded.token, "abc123")
})

test("pairing round-trips https with token", () => {
  const s = encodePairing({ url: "https://memory.example.com:8443", token: "tok" })
  assert.equal(s, "nodus+https://tok@memory.example.com:8443")
  const decoded = decodePairing(s)
  assert.equal(decoded.url, "https://memory.example.com:8443")
  assert.equal(decoded.token, "tok")
})

test("pairing without token (loopback case)", () => {
  const s = encodePairing({ url: "http://127.0.0.1:7475" })
  assert.equal(s, "nodus://127.0.0.1:7475")
  const decoded = decodePairing(s)
  assert.equal(decoded.url, "http://127.0.0.1:7475")
  assert.equal(decoded.token, undefined)
})

test("pairing handles tokens with special characters", () => {
  const token = "ab+/c=de"
  const s = encodePairing({ url: "http://10.0.0.1:7475", token })
  const decoded = decodePairing(s)
  assert.equal(decoded.token, token)
})

test("isPairingString recognises both schemes", () => {
  assert.equal(isPairingString("nodus://x@host:1"), true)
  assert.equal(isPairingString("nodus+https://x@host:1"), true)
  assert.equal(isPairingString("http://host:1"), false)
  assert.equal(isPairingString("nodus"), false)
  assert.equal(isPairingString("  nodus://x@host:1  "), true)
})

test("decodePairing rejects non-pairing input", () => {
  assert.throws(() => decodePairing("http://host:1"), /not a pairing string/)
  assert.throws(() => decodePairing("nodus://"), /malformed pairing string|missing host/)
})

test("encodePairing rejects non-http URLs", () => {
  assert.throws(() => encodePairing({ url: "file:///x" }), /only support http/)
})

test("redactPairingString hides token", () => {
  const s = encodePairing({ url: "http://192.168.1.20:7475", token: "abc123" })
  assert.equal(redactPairingString(s), "nodus://redacted@192.168.1.20:7475")
  assert.equal(redactPairingString("nodus://127.0.0.1:7475"), "nodus://127.0.0.1:7475")
})
