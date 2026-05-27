import { resolve } from "node:path"
import { BackendError, ContextBackend } from "./types.js"

export interface ModuleBackendOptions {
  /** npm package name or absolute path / file:// URL to a JS module. */
  path: string
  /** Arbitrary options passed to the module's factory. */
  options?: unknown
}

/**
 * Loads a backend from an external module. The module must default-export
 * (or named-export `createBackend`) a function:
 *
 *     (options?: unknown) => ContextBackend | Promise<ContextBackend>
 *
 * Resolution: bare specifiers like "@acme/foo" use Node module resolution;
 * absolute paths and file:// URLs are imported directly.
 */
export async function loadModuleBackend(
  options: ModuleBackendOptions,
): Promise<ContextBackend> {
  if (!options.path) throw new BackendError("ModuleBackend: path is required")

  const specifier = resolveSpecifier(options.path)
  let mod: any
  try {
    mod = await import(specifier)
  } catch (e: any) {
    throw new BackendError(
      `could not load backend module "${options.path}": ${e?.message ?? e}`,
      e,
    )
  }

  const factory = mod.createBackend ?? mod.default
  if (typeof factory !== "function") {
    throw new BackendError(
      `module "${options.path}" must export createBackend or a default function returning a ContextBackend`,
    )
  }

  let backend: ContextBackend
  try {
    backend = await factory(options.options)
  } catch (e: any) {
    throw new BackendError(
      `backend factory threw for "${options.path}": ${e?.message ?? e}`,
      e,
    )
  }

  if (!backend || typeof backend.describe !== "function") {
    throw new BackendError(
      `module "${options.path}" factory did not return a ContextBackend`,
    )
  }
  return backend
}

function resolveSpecifier(path: string): string {
  if (path.startsWith("./") || path.startsWith("../") || path.startsWith("/")) {
    return new URL(`file://${resolve(path)}`).href
  }
  return path
}
