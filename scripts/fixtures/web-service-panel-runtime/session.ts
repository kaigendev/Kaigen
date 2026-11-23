// Disposable layout backend only: no device keys, network or Push delivery.
export const calls: unknown[] = [];
Object.assign(window, { workspaceCalls: calls });
type Workspace = { storageMode: string; usedBytes: number; quotaBytes: number; expiresAt: number };
type Record = { selector: string; password: string; workspace: Workspace };
const records = new Map<string, Record>();
const navigationMode = new URLSearchParams(location.search).has("navigation");
const fixturePassword = "disposable-password";
const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
export const navigationFixture = {
  failPrepare: false,
  hold(name: string) {
    let resolve!: () => void;
    gates.set(name, { promise: new Promise<void>((done) => { resolve = done; }), resolve });
  },
  release(name: string) { gates.get(name)?.resolve(); gates.delete(name); },
  pause: (name: string) => gates.get(name)?.promise ?? Promise.resolve(),
  record(name: string) {
    if (!navigationMode) return;
    const log = JSON.parse(sessionStorage.getItem("fixture-navigation-log") ?? "[]") as string[];
    log.push(name); sessionStorage.setItem("fixture-navigation-log", JSON.stringify(log));
  },
};
Object.assign(window, { workspaceNavigationFixture: navigationFixture });
if (navigationMode) {
  for (const name of ["a", "b", "c"]) records.set(name.repeat(48), {
    selector: `fixture-${name}`, password: fixturePassword,
    workspace: { storageMode: "ram", usedBytes: 0, quotaBytes: 134217728, expiresAt: Date.now() + 3600000 },
  });
  if (location.hash.endsWith("a".repeat(48)) && new URLSearchParams(location.search).get("hold") === "lookup") navigationFixture.hold("lookup");
}
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
let creationPending = false;
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
  getWorkspace: () => workspace,
  async lookupWorkspace() {
    const captured = identifier;
    navigationFixture.record("lookup");
    await navigationFixture.pause("lookup");
    return { exists: records.has(captured), provisional: false };
  },
  requiresPassword: async () => new URLSearchParams(location.search).has("auth") && identifier === "a".repeat(48),
  async restoreDeviceSession() { return this.login(fixturePassword); },
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
  async createWorkspace(args: { storageMode?: string; accessPassword: string }, _progress?: unknown, current = () => true) {
    calls.push(args);
    if (new URLSearchParams(location.search).has("fail")) throw new Error("CREATION_UNAVAILABLE");
    navigationFixture.record("create");
    await navigationFixture.pause("create");
    if (!current()) throw new Error("SESSION_NOT_ACTIVE");
    creationPending = true;
    navigationFixture.record("create-post");
    await navigationFixture.pause("create-post");
    allocations += 1;
    const id = allocations === 1 ? "a".repeat(48) : allocations.toString(16).padStart(48, "a");
    records.set(id, { selector: "fixture-workspace-" + allocations, password: args.accessPassword,
      workspace: { storageMode: args.storageMode ?? "ram", usedBytes: 0, quotaBytes: 134217728, expiresAt: Date.now() + 3600000 } });
    this.setIdentifier(id);
    return { identifier: id };
  },
  async login(password: string, current = () => true) {
    navigationFixture.record("login");
    await navigationFixture.pause("login");
    if (!current()) throw new Error("SESSION_NOT_ACTIVE");
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
  isWorkspaceCreationPending: () => creationPending,
  finishWorkspaceCreation() { creationPending = false; },
  cancelWorkspaceOpening() {
    if (creationPending) throw new Error("WORKSPACE_CONTROL_BUSY");
    navigationFixture.record("cancel-opening");
  },
  async leaveWorkspace() {
    if (creationPending) throw new Error("WORKSPACE_CONTROL_BUSY");
    navigationFixture.record("leave");
    await navigationFixture.pause("leave");
    lifecycle = "closed"; workspace = null; csrfTokenPresent = false;
  },
  async lockWorkspace() { navigationFixture.record("lock"); endSession(); },
  async closeWorkspace() { navigationFixture.record("close"); endSession(); },
  async destroyWorkspace() { const removed = identifier; endSession(); records.delete(removed); identifier = ""; },
};
