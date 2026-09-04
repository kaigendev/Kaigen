export type TorStatus = {
  state: "disabled" | "starting" | "connecting" | "connected" | "error";
  progress: number;
  message: string | null;
  socksPort: number | null;
  controlPort: number | null;
  transport: string;
};

export type ProxySettings = {
  mode: "none" | "socks5" | "http";
  host: string;
  port: number;
  username: string;
  password: string;
};

const COLD_START_TOR_STATUS: TorStatus = {
  state: "starting",
  progress: 0,
  message: "Запуск Tor",
  socksPort: null,
  controlPort: null,
  transport: "none",
};

let retainedTorStatus: TorStatus | null = null;
let retainedProxyMode: ProxySettings["mode"] | null = null;

const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  mode: "none",
  host: "127.0.0.1",
  port: 9050,
  username: "",
  password: "",
};

function copyTorStatus(status: TorStatus): TorStatus {
  return { ...status };
}

export function initialTorStatus(): TorStatus {
  return copyTorStatus(retainedTorStatus ?? COLD_START_TOR_STATUS);
}

export function retainTorStatus(status: TorStatus): TorStatus {
  retainedTorStatus = copyTorStatus(status);
  return copyTorStatus(retainedTorStatus);
}

export function initialProxySettings(): ProxySettings {
  return {
    ...DEFAULT_PROXY_SETTINGS,
    mode: retainedProxyMode ?? DEFAULT_PROXY_SETTINGS.mode,
  };
}

export function retainProxySettings(settings: ProxySettings): ProxySettings {
  retainedProxyMode = settings.mode;
  return initialProxySettings();
}
