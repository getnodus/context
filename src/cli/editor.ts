import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function editInEditor(initial: string, filenameHint = "entry.md"): Promise<string> {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi"
  const dir = await mkdtemp(join(tmpdir(), "context-"))
  const file = join(dir, filenameHint)
  await writeFile(file, initial, "utf8")

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: "inherit" })
      child.on("exit", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`editor exited with code ${code}`))
      })
      child.on("error", reject)
    })
    return await readFile(file, "utf8")
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
