type CreationArguments = { storageMode: "disk" | "ram"; accessPassword: string; language: string };
type Workspace = { storageMode: "disk" | "ram"; leaseSeconds: null; quotaBytes: null; usedBytes: number };
export const calls: unknown[] = [];
Object.assign(window, { workspaceCalls: calls });
const workspaceListeners = new Set<(workspace: Workspace) => void>();
let record: { identifier: string; selector: string; args: CreationArguments } | null = null;
let workspace: Workspace | null = null;
let identifier = "", selector = "";
let active = false, csrfTokenPresent = false;
let generation = 0, authenticationRevision = 0;
export const webSession = {
  onWorkspace(handler: (workspace: Workspace) => void) {
    workspaceListeners.add(handler);
    if (workspace) handler(workspace);
    return () => { workspaceListeners.delete(handler); };
  },
  onUpgradeRequired: () => () => {},
  onSessionUnavailable: (_handler: (reload: boolean) => void) => () => {},
  verifyBuildIdentity: async () => {},
  getIdentifier: () => identifier,
  getWorkspace: () => workspace,
  isWorkspaceCreationPending: () => false,
  finishWorkspaceCreation() {},
  cancelWorkspaceOpening() {},
  async leaveWorkspace() { active = false; workspace = null; csrfTokenPresent = false; },
  captureNotificationSession() {
    if (!active || !workspace || !csrfTokenPresent || !selector) return null;
    const capturedGeneration = generation, capturedRevision = authenticationRevision, capturedSelector = selector;
    return {
      epoch: capturedGeneration + ":" + capturedRevision,
      namespace: crypto.subtle.digest("SHA-256", new TextEncoder().encode("kaigen-notification-intent/v1\0" + capturedSelector))
        .then(bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")),
      isCurrent: () => active && !!workspace && csrfTokenPresent && generation === capturedGeneration
        && authenticationRevision === capturedRevision && selector === capturedSelector,
    };
  },
  createWorkspace: async (args: CreationArguments) => {
    calls.push(args);
    if (new URLSearchParams(location.search).has("fail")) throw new Error("DISPOSABLE_CREATION_FAILURE ".repeat(15));
    generation += 1;
    active = false; csrfTokenPresent = false; workspace = null; selector = "";
    record = { identifier: "a".repeat(48), selector: crypto.randomUUID(), args };
    identifier = record.identifier;
    return { identifier };
  },
  login: async (password: string) => {
    if (!record || password !== record.args.accessPassword || identifier !== record.identifier) throw new Error("AUTH_BAD");
    generation += 1; authenticationRevision += 1;
    active = true; csrfTokenPresent = true; selector = record.selector;
    workspace = { storageMode: record.args.storageMode, leaseSeconds: null, quotaBytes: null, usedBytes: 0 };
    for (const handler of workspaceListeners) handler(workspace);
  },
};
