import { createInterface } from "node:readline/promises"

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const hint = defaultYes ? "[Y/n]" : "[y/N]"
  try {
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase()
    if (answer === "") return defaultYes
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}
