export const COMPONENT_VERSIONS = Object.freeze({
  app: "0.3.6",
  appManifest: "0.3.6",
  webBackendManifest: "0.3.6",
  tauri: "2.12.4",
  tauriCli: "2.12.3",
  react: "19.3.1",
  typescript: "7.0.2",
  ffmpegCore: "0.12.10",
  ffmpeg: "5.1.4",
  cToxcore: "0.2.24-rc.2",
  cToxcoreCommit: "d34d16e6473f61545fed9d8cb59bb1e86da993f1",
  libsodium: "1.0.22-stable",
  libsodiumSnapshot: "2026-10-13",
  libsodiumMsvcSnapshot: "2026-10-15",
  mlkemNative: "2.0.0",
  torExpertBundle: "15.0.25",
  tor: "0.4.9.14",
  lyrebird: "0.9.0-kaigen-snowflake2.15.1-pion4.2.23-dtls3.1.12",
  lyrebirdMacos: "0.9.0-kaigen-snowflake2.15.1-pion4.2.23-dtls3.1.12",
  torGeoIpDataset: "2026-10-15",
  webView2: "155.0.4283.45",
  nspell: "2.1.5",
  hunspellEnglish: "4.0.0",
  hunspellRussian: "3.0.0",
  hunspellDictionariesCommit: "8cfea406b505e4d7df52d5a19bce525df98c54ab",
  sqlcipherImportRuntime: "4.19.0",
  sqliteImportRuntime: "3.54.0",
  opensslImportRuntime: "4.0.3",
});

declare const __KAIGEN_RUNTIME_PLATFORM__: string;

export function getRuntimeLyrebirdVersion() {
  if (typeof __KAIGEN_RUNTIME_PLATFORM__ === "undefined") return null;
  if (["windows", "linux", "macos", "web"].includes(__KAIGEN_RUNTIME_PLATFORM__)) return COMPONENT_VERSIONS.lyrebird;
  return null;
}
