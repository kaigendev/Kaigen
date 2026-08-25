export const WEB_API_VERSION = "v1" as const;

export type StorageMode = "disk" | "ram";

export type WorkspaceView = {
  storageMode: StorageMode;
  expiresAt: number | null;
  leaseSeconds: number | null;
  uiLease: "owned" | "occupied" | "stale";
  maintenance: boolean;
  quotaBytes: number | null;
  usedBytes: number;
};

export type InitializerChallenge = {
  challengeId: string;
  salt: string;
  difficulty: number;
  expiresAt: number;
};

export type ProofSolution = {
  challengeId: string;
  nonce: number;
};

export type CreateWorkspaceRequest = {
  storageMode: StorageMode;
  profileName: string;
  password: string;
  language: "ru" | "en";
  proof: ProofSolution;
};

export type CreateWorkspaceResponse = {
  identifier: string;
  workspace: WorkspaceView;
};

export type SessionResponse = {
  csrfToken: string;
  deviceId: string;
  workspace: WorkspaceView;
};

export type DeviceChallenge = {
  challenge: string;
};

export type WebEvent<T = unknown> = {
  event: string;
  payload: T;
};

export type ApiErrorBody = {
  code?: string;
  message?: string;
};
