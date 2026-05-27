import { BackendError, ContextBackend } from "./types.js"
import { LocalBackend } from "./local.js"
import { HttpBackend, HttpBackendOptions } from "./http.js"
import { loadModuleBackend, ModuleBackendOptions } from "./module.js"
import { MirrorBackend } from "./mirror.js"

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

/**
 * Mirror profile: reads come from `primary`, writes go to both. The most
 * common shape is `primary: local`, `secondary: http` — fast offline reads
 * with durable replication.
 */
export interface ProfileMirror {
  type: "mirror"
  primary: Profile
  secondary: Profile
}

export type Profile = ProfileLocal | ProfileHttp | ProfileModule | ProfileMirror

export async function createBackend(profile: Profile): Promise<ContextBackend> {
  switch (profile.type) {
    case "local":
      return new LocalBackend({ rootDir: profile.rootDir })
    case "http":
      return new HttpBackend(profile)
    case "module":
      return loadModuleBackend(profile)
    case "mirror": {
      const primary = await createBackend(profile.primary)
      const secondary = await createBackend(profile.secondary)
      return new MirrorBackend({ primary, secondary })
    }
    default:
      throw new BackendError(
        `unknown backend type: ${(profile as { type: string }).type}`,
      )
  }
}
