import { BackendError, ContextBackend } from "./types.js"
import { LocalBackend } from "./local.js"
import { HttpBackend, HttpBackendOptions } from "./http.js"
import { loadModuleBackend, ModuleBackendOptions } from "./module.js"

export interface ProfileLocal {
  type: "local"
  /** Override the default ~/.nodus/context root. */
  rootDir?: string
}

export interface ProfileHttp extends Omit<HttpBackendOptions, "fetch"> {
  type: "http"
}

export interface ProfileModule extends ModuleBackendOptions {
  type: "module"
}

export type Profile = ProfileLocal | ProfileHttp | ProfileModule

export async function createBackend(profile: Profile): Promise<ContextBackend> {
  switch (profile.type) {
    case "local":
      return new LocalBackend({ rootDir: profile.rootDir })
    case "http":
      return new HttpBackend(profile)
    case "module":
      return loadModuleBackend(profile)
    default:
      throw new BackendError(
        `unknown backend type: ${(profile as { type: string }).type}`,
      )
  }
}
