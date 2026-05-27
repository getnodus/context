import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"

/**
 * Prompt primitives for the setup wizard. Uses TTY raw mode for the
 * arrow-key flows (single/multi select) and stays compatible with
 * non-interactive shells by failing fast — wizards aren't appropriate
 * in pipes anyway; callers should use the `--yes` non-interactive path.
 *
 * Output goes to stderr so the wizard never corrupts stdout streams
 * (matches the rest of the CLI's split: data on stdout, UI on stderr).
 */

const ESC = "\x1b"
const CLEAR_LINE = `${ESC}[2K`
const MOVE_UP = (n: number) => (n > 0 ? `${ESC}[${n}A` : "")
const SHOW_CURSOR = `${ESC}[?25h`
const HIDE_CURSOR = `${ESC}[?25l`

function write(s: string): void {
  process.stderr.write(s)
}

function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY)
}

function requireTty(what: string): void {
  if (!isTty()) {
    throw new Error(
      `${what} requires an interactive terminal. Re-run with --yes for non-interactive defaults.`,
    )
  }
}

export async function ask(
  question: string,
  options: { default?: string; allowEmpty?: boolean } = {},
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const hint = options.default ? ` (${options.default})` : ""
  try {
    while (true) {
      const raw = await rl.question(`${question}${hint} > `)
      const value = raw.trim() || options.default || ""
      if (value || options.allowEmpty) return value
      write("  (required)\n")
    }
  } finally {
    rl.close()
  }
}

/**
 * Password-style prompt: characters typed are not echoed. Suitable for
 * tokens. Does NOT show "*" per character (no length leak); just shows
 * the prompt and waits for Enter.
 */
export async function askSecret(question: string): Promise<string> {
  requireTty(question)
  return new Promise((resolve, reject) => {
    write(`${question} > `)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    let buf = ""
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData)
          stdin.setRawMode(false)
          stdin.pause()
          write("\n")
          resolve(buf)
          return
        }
        if (ch === "\x03") {
          stdin.removeListener("data", onData)
          stdin.setRawMode(false)
          stdin.pause()
          write("\n")
          reject(new Error("cancelled"))
          return
        }
        if (ch === "\x7f" || ch === "\b") {
          // backspace
          buf = buf.slice(0, -1)
          continue
        }
        buf += ch
      }
    }
    stdin.on("data", onData)
  })
}

export interface Choice<T = string> {
  value: T
  label: string
  hint?: string
}

/**
 * Arrow-key single-select. Up/Down to move, Enter to confirm, Ctrl+C to
 * abort. Renders inline and erases itself on confirm — leaves a single
 * "> question: <chosen label>" line so the wizard transcript is readable
 * after the fact.
 */
export async function selectOne<T>(
  question: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  requireTty(question)
  if (choices.length === 0) throw new Error("selectOne: no choices provided")
  let cursor = Math.max(0, Math.min(defaultIndex, choices.length - 1))

  const render = (initial: boolean): void => {
    if (!initial) write(MOVE_UP(choices.length + 1))
    write(`${CLEAR_LINE}${question}\n`)
    for (let i = 0; i < choices.length; i++) {
      const sel = i === cursor ? "›" : " "
      const hint = choices[i].hint ? `  \x1b[2m${choices[i].hint}\x1b[0m` : ""
      const line = i === cursor ? `\x1b[36m${choices[i].label}\x1b[0m` : choices[i].label
      write(`${CLEAR_LINE} ${sel} ${line}${hint}\n`)
    }
  }

  return new Promise((resolve, reject) => {
    write(HIDE_CURSOR)
    render(true)
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const onKey = (_: unknown, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        finish()
        write(SHOW_CURSOR)
        reject(new Error("cancelled"))
        return
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + choices.length) % choices.length
        render(false)
        return
      }
      if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % choices.length
        render(false)
        return
      }
      if (key.name === "return" || key.name === "enter") {
        finish()
        write(MOVE_UP(choices.length + 1))
        for (let i = 0; i <= choices.length; i++) write(`${CLEAR_LINE}`)
        write(MOVE_UP(choices.length + 1))
        write(`${question}: \x1b[36m${choices[cursor].label}\x1b[0m\n`)
        write(SHOW_CURSOR)
        resolve(choices[cursor].value)
        return
      }
    }
    const finish = () => {
      process.stdin.removeListener("keypress", onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdin.on("keypress", onKey)
  })
}

/**
 * Multi-select checkbox list. Space toggles, Enter confirms, "a" toggles
 * all. Initial selection comes from `defaultChecked` (a Set of values
 * or a predicate on each choice).
 */
export async function selectMany<T>(
  question: string,
  choices: Choice<T>[],
  defaultChecked: (choice: Choice<T>) => boolean = () => false,
): Promise<T[]> {
  requireTty(question)
  if (choices.length === 0) return []
  let cursor = 0
  const checked = new Set<number>()
  for (let i = 0; i < choices.length; i++) {
    if (defaultChecked(choices[i])) checked.add(i)
  }

  const render = (initial: boolean): void => {
    if (!initial) write(MOVE_UP(choices.length + 2))
    write(`${CLEAR_LINE}${question}\n`)
    write(`${CLEAR_LINE}\x1b[2m  space to toggle · a toggles all · enter to confirm\x1b[0m\n`)
    for (let i = 0; i < choices.length; i++) {
      const sel = i === cursor ? "›" : " "
      const box = checked.has(i) ? "[\x1b[32m✓\x1b[0m]" : "[ ]"
      const hint = choices[i].hint ? `  \x1b[2m${choices[i].hint}\x1b[0m` : ""
      const line = i === cursor ? `\x1b[36m${choices[i].label}\x1b[0m` : choices[i].label
      write(`${CLEAR_LINE} ${sel} ${box} ${line}${hint}\n`)
    }
  }

  return new Promise((resolve, reject) => {
    write(HIDE_CURSOR)
    render(true)
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const onKey = (
      _: unknown,
      key: { name?: string; sequence?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === "c") {
        finish()
        write(SHOW_CURSOR)
        reject(new Error("cancelled"))
        return
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + choices.length) % choices.length
        render(false)
        return
      }
      if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % choices.length
        render(false)
        return
      }
      if (key.name === "space" || key.sequence === " ") {
        if (checked.has(cursor)) checked.delete(cursor)
        else checked.add(cursor)
        render(false)
        return
      }
      if (key.name === "a") {
        if (checked.size === choices.length) checked.clear()
        else for (let i = 0; i < choices.length; i++) checked.add(i)
        render(false)
        return
      }
      if (key.name === "return" || key.name === "enter") {
        finish()
        const labels = Array.from(checked)
          .sort((a, b) => a - b)
          .map((i) => choices[i].label)
        write(MOVE_UP(choices.length + 2))
        for (let i = 0; i <= choices.length + 1; i++) write(`${CLEAR_LINE}`)
        write(MOVE_UP(choices.length + 2))
        write(`${question}: \x1b[36m${labels.join(", ") || "(none)"}\x1b[0m\n`)
        write(SHOW_CURSOR)
        resolve(Array.from(checked).map((i) => choices[i].value))
        return
      }
    }
    const finish = () => {
      process.stdin.removeListener("keypress", onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdin.on("keypress", onKey)
  })
}

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
