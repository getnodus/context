export * from "./types.js"
export { LocalBackend, type LocalBackendOptions } from "./local.js"
export { HttpBackend, type HttpBackendOptions } from "./http.js"
export { loadModuleBackend, type ModuleBackendOptions } from "./module.js"
export {
  createBackend,
  type Profile,
  type ProfileLocal,
  type ProfileHttp,
  type ProfileModule,
  type ProfileMirror,
} from "./factory.js"
export { MirrorBackend, type MirrorBackendOptions } from "./mirror.js"
export { getDefaultLocalDir, getNodusConfigDir } from "./paths.js"
export {
  type EmbeddingProvider,
  OllamaEmbedder,
  type OllamaEmbedderOptions,
  cosineSimilarity,
  makeEmbedderFromEnv,
} from "./embeddings.js"
