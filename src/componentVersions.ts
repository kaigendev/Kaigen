export const COMPONENT_VERSIONS = Object.freeze({
  app: "0.3RC3",
  appManifest: "0.3.0-rc.3",
  webBackendManifest: "0.3.0-rc.3",
  tauri: "2.12.3",
  tauriCli: "2.12.2",
  react: "19.3.0",
  typescript: "7.0.2",
  cToxcore: "0.2.24-rc.2",
  cToxcoreCommit: "ec7bd2cce618ed6542fbc55b84574704eb380ef2",
  libsodium: "1.0.22-stable",
  libsodiumSnapshot: "2026-10-13",
  mlkemNative: "2.0.0",
  torExpertBundle: "15.0.25",
  tor: "0.4.9.14",
  lyrebird: "0.9.0",
  lyrebirdMacos: "0.8.1",
  torGeoIpDataset: "2026-10-14",
  webView2: "155.0.4283.45",
  nspell: "2.1.5",
  hunspellEnglish: "4.0.0",
  hunspellRussian: "3.0.0",
  hunspellDictionariesCommit: "8cfea406b505e4d7df52d5a19bce525df98c54ab",
  sqlcipherImportRuntime: "4.19.0",
  sqliteImportRuntime: "3.53.4",
  opensslImportRuntime: "4.0.3",
});

declare const __KAIGEN_RUNTIME_PLATFORM__: string;

export function getRuntimeLyrebirdVersion() {
  if (typeof __KAIGEN_RUNTIME_PLATFORM__ === "undefined") return null;
  if (__KAIGEN_RUNTIME_PLATFORM__ === "macos") return COMPONENT_VERSIONS.lyrebirdMacos;
  if (["windows", "linux", "web"].includes(__KAIGEN_RUNTIME_PLATFORM__)) return COMPONENT_VERSIONS.lyrebird;
  return null;
}
