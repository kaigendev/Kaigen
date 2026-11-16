// Disposable layout backend only: no device keys, network or Push delivery.
export const calls: unknown[] = [];
Object.assign(window, { workspaceCalls: calls });
type Workspace = { storageMode: string; usedBytes: number; quotaBytes: number; expiresAt: number };
type Record = { selector: string; password: string; workspace: Workspace };
const records = new Map<string, Record>();
const workspaceListeners = new Set<(workspace: Workspace | null) => void>();
const unavailableListeners = new Set<(reload: boolean) => void>();
let identifier = "";
let workspace: Workspace | null = null;
let selector = "";
let lifecycle: "active" | "closed" = "closed";
let csrfTokenPresent = false;
let unavailable = false;
let generation = 0;
let revision = 0;
let allocations = 0;
let autoRenew = false;
const publishWorkspace = () => { for (const listener of workspaceListeners) listener(workspace); };
const assertActive = () => {
  if (lifecycle !== "active" || !workspace || !csrfTokenPresent || !selector) throw new Error("SESSION_NOT_ACTIVE");
};
function endSession() {
  lifecycle = "closed";
  generation += 1;
  workspace = null;
  selector = "";
  csrfTokenPresent = false;
  unavailable = true;
  publishWorkspace();
  for (const listener of unavailableListeners) listener(false);
}
export const webSession = {
  onWorkspace(handler: (workspace: Workspace | null) => void) {
    workspaceListeners.add(handler);
    if (workspace) handler(workspace);
    return () => { workspaceListeners.delete(handler); };
  },
  onUpgradeRequired: () => () => {},
  onSessionUnavailable(handler: (reload: boolean) => void) {
    unavailableListeners.add(handler);
    if (unavailable) handler(false);
    return () => { unavailableListeners.delete(handler); };
  },
  verifyBuildIdentity: async () => {},
  getIdentifier: () => identifier,
  setIdentifier(value: string) {
    const next = value.trim();
    if (next !== identifier) { workspace = null; selector = ""; generation += 1; }
    identifier = next;
  },
  captureNotificationSession() {
    if (lifecycle !== "active" || !workspace || !csrfTokenPresent || !selector) return null;
    const capturedGeneration = generation;
    const capturedRevision = revision;
    const capturedSelector = selector;
    return {
      epoch: capturedGeneration + ":" + capturedRevision,
      namespace: crypto.subtle.digest("SHA-256", new TextEncoder().encode("kaigen-notification-intent/v1\0" + capturedSelector))
        .then(bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")),
      isCurrent: () => lifecycle === "active" && !!workspace && csrfTokenPresent
        && generation === capturedGeneration && revision === capturedRevision && selector === capturedSelector,
    };
  },
  async createWorkspace(args: { storageMode?: string; accessPassword: string }) {
    calls.push(args);
    if (new URLSearchParams(location.search).has("fail")) throw new Error("CREATION_UNAVAILABLE");
    allocations += 1;
    const id = allocations === 1 ? "a".repeat(48) : allocations.toString(16).padStart(48, "a");
    records.set(id, { selector: "fixture-workspace-" + allocations, password: args.accessPassword,
      workspace: { storageMode: args.storageMode ?? "ram", usedBytes: 0, quotaBytes: 134217728, expiresAt: Date.now() + 3600000 } });
    this.setIdentifier(id);
    return { identifier: id };
  },
  async login(password: string) {
    generation += 1;
    const record = records.get(identifier);
    if (!record || record.password !== password) throw new Error("AUTH_BAD");
    lifecycle = "active";
    csrfTokenPresent = true;
    unavailable = false;
    revision += 1;
    selector = record.selector;
    workspace = { ...record.workspace };
    publishWorkspace();
    return workspace;
  },
  async command<T>(command: string) {
    assertActive();
    if (command === "web_push_config") return { publicKey: "", enabled: false, intentEnabled: false, needsRebind: false, intentRevision: "0" } as T;
    throw new Error("FIXTURE_COMMAND_UNAVAILABLE: " + command);
  },
  setAutoRenewOnHeartbeat(value: boolean) { autoRenew = value; },
  async heartbeat() {
    assertActive();
    if (autoRenew) { workspace = { ...workspace!, expiresAt: Date.now() + 3600000 }; records.get(identifier)!.workspace = workspace; }
    publishWorkspace();
    return workspace;
  },
  async renewLease() {
    assertActive();
    workspace = { ...workspace!, expiresAt: Date.now() + 3600000 };
    records.get(identifier)!.workspace = workspace;
    publishWorkspace();
    return workspace;
  },
  async lockWorkspace() { endSession(); },
  async closeWorkspace() { endSession(); },
  async destroyWorkspace() { const removed = identifier; endSession(); records.delete(removed); identifier = ""; },
};
