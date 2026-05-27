import { createBackend, ContextBackend } from "../backends/index.js"
import { getActiveProfile } from "../config/index.js"

/**
 * Resolve the active backend for CLI commands. Reads the config, picks the
 * active profile, instantiates the backend, and calls init() if defined.
 */
export async function getBackend(): Promise<ContextBackend> {
  const { profile } = await getActiveProfile()
  const backend = await createBackend(profile)
  await backend.init?.()
  return backend
}
