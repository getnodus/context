import { ContextBackend } from "../src/backends/index.js"
import { startServer } from "../src/server/index.js"

/**
 * Reference implementation of the Nodus Context HTTP protocol, backed by
 * any ContextBackend (typically LocalBackend in tests). Used to verify
 * that HttpBackend speaks the protocol correctly.
 *
 * Internally delegates to the same handler the production
 * `nodus-context-server` bin uses, so the conformance suite exercises the
 * real server code.
 */
export async function startStubServer(
  backend: ContextBackend,
  options: { token?: string; acksRootDir?: string; acksFile?: string } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const running = await startServer(backend, {
    port: 0,
    host: "127.0.0.1",
    ...(options.token ? { token: options.token } : {}),
    ...(options.acksRootDir ? { acksRootDir: options.acksRootDir } : {}),
    ...(options.acksFile ? { acksFile: options.acksFile } : {}),
  })
  return { url: running.url, close: running.close }
}
