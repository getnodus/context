import { isatty } from "node:tty"

export async function readStdin(): Promise<string> {
  if (isatty(0)) return ""
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function stdinIsTty(): boolean {
  return isatty(0)
}
