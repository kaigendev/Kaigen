const LAUNCH_PARAMETER = "kaigen-launch";
const BOUND_STORAGE_KEY = "kaigen.web.launch.bound.v1";
const TOKEN_STORAGE_PREFIX = "kaigen.web.launch.token.v1.";
const HISTORY_FIELD = "kaigenWebLaunch";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{40,80}$/u;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

type LaunchRecord = { v: 1; identifier: string | null };
type DocumentLaunch = { token: string; identifier: string | null };
type StoredLaunch =
  | { state: "absent" | "invalid" | "unavailable" }
  | { state: "present"; identifier: string | null };

let initialized = false;
let documentToken: string | null = null;
let confirmedIdentifier: string | null = null;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function installedWindow(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: minimal-ui)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function webKitInstallation(): boolean {
  const agent = navigator.userAgent;
  const appleMobile = /iPad|iPhone|iPod/u.test(agent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return /AppleWebKit/u.test(agent) && (appleMobile
    || (/Apple/u.test(navigator.vendor) && /Safari/u.test(agent)
      && !/Chrome|Chromium|Edg|OPR/u.test(agent)));
}

function readLaunch(key: string): StoredLaunch {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { state: "absent" };
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { state: "invalid" };
    const record = value as Partial<LaunchRecord>;
    if (record.v !== 1 || !(record.identifier === null || validIdentifier(record.identifier))) {
      return { state: "invalid" };
    }
    return { state: "present", identifier: record.identifier };
  } catch {
    // Storage denial and malformed records must leave manual entry available.
    return { state: "unavailable" };
  }
}

function writeLaunch(key: string, identifier: string | null): boolean {
  try {
    const record: LaunchRecord = { v: 1, identifier };
    window.localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function fragmentIdentifier(url: URL): string | null {
  return /^#(?:k=)?([A-Za-z0-9_-]{40,80})$/u.exec(url.hash)?.[1] ?? null;
}

function replaceDocumentUrl(url: URL): void {
  if (url.href !== window.location.href) {
    // The password-required fallback belongs to this history entry.
    window.history.replaceState(window.history.state, "", url.href);
  }
}

function rememberDocumentToken(identifier: string | null): void {
  if (!documentToken) return;
  try {
    const previous: unknown = window.history.state;
    if (previous !== null && typeof previous !== "object") return;
    window.history.replaceState({
      ...previous,
      [HISTORY_FIELD]: { token: documentToken, identifier } satisfies DocumentLaunch,
    }, "", window.location.href);
  } catch {
    // A failed history write must not prevent manual entry or authentication.
  }
}

function newDocumentToken(identifier: string | null): string | null {
  try {
    // This random selector is public. It is never derived from the workspace key.
    documentToken = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
      value => value.toString(16).padStart(2, "0")).join("");
    rememberDocumentToken(identifier);
    return documentToken;
  } catch {
    documentToken = null;
    return null;
  }
}

function initializeDocumentToken(identifier: string | null): void {
  // History can be copied into a duplicate tab. Share only a confirmed immutable
  // slot; every new blank document gets its own unallocated selector.
  const state: unknown = window.history.state;
  if (typeof state === "object" && state !== null && HISTORY_FIELD in state) {
    const entry: unknown = (state as Record<string, unknown>)[HISTORY_FIELD];
    if (typeof entry === "object" && entry !== null) {
      const saved = entry as Partial<DocumentLaunch>;
      if (validToken(saved.token) && saved.identifier === identifier) {
        const mapping = readLaunch(TOKEN_STORAGE_PREFIX + saved.token);
        if (mapping.state === "present" && mapping.identifier !== null
          && mapping.identifier === identifier) {
          documentToken = saved.token;
          return;
        }
      }
    }
  }
  newDocumentToken(identifier);
}

function exposeManifest(): void {
  const path = webKitInstallation() ? "/manifest-webkit.webmanifest"
    : documentToken ? `/api/v1/install-manifest/${documentToken}` : "/manifest.webmanifest";
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    ?? document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = new URL(path, window.location.origin).href;
  if (!manifest.isConnected) document.head.append(manifest);
}

/** Resolve only an installed launch entry, before React consumes the fragment. */
export function initializeWebLaunch(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const url = new URL(window.location.href);
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  const installed = installedWindow();
  const webKit = webKitInstallation();
  const marker = url.searchParams.getAll(LAUNCH_PARAMETER);
  const token = marker.length === 1 && validToken(marker[0]) ? marker[0] : null;
  const launchEntry = url.pathname === "/" && ((marker.length === 1
    && (marker[0] === "1" || token !== null)) || (!url.hash && marker.length === 0));
  const seed = fragmentIdentifier(url);

  // Explicit unmarked links and malformed fragments are never replaced by a
  // remembered key. A launcher resolves only its own document's local mapping.
  if (installed && launchEntry && (!url.hash || seed)) {
    const bound = readLaunch(BOUND_STORAGE_KEY);
    if (bound.state === "present") {
      // A null record is a tombstone: never revive the shortcut's old seed.
      url.hash = bound.identifier ? `k=${bound.identifier}` : "";
    } else if (bound.state === "absent" && token) {
      const mapping = readLaunch(TOKEN_STORAGE_PREFIX + token);
      url.hash = mapping.state === "present" && mapping.identifier
        ? `k=${mapping.identifier}` : "";
    }
    replaceDocumentUrl(url);
  } else if (!installed && webKit) {
    // WebKit snapshots the document URL when start_url is omitted. Mark that
    // install seed before exposing the manifest, without putting its key in it.
    url.searchParams.set(LAUNCH_PARAMETER, "1");
    replaceDocumentUrl(url);
  }

  if (!webKit) {
    if (installed && token && launchEntry) documentToken = token;
    else initializeDocumentToken(fragmentIdentifier(url));
  }
  exposeManifest();
  window.addEventListener("appinstalled", () => {
    // Installation can transfer this document into an app window. Preserve an
    // existing binding, and never turn a blank installation into a tombstone.
    if (confirmedIdentifier && readLaunch(BOUND_STORAGE_KEY).state === "absent") {
      writeLaunch(BOUND_STORAGE_KEY, confirmedIdentifier);
    }
  });
}

/** Call only after the server confirms creation or lookup of this workspace. */
export function rememberWorkspaceLaunch(identifier: string): boolean {
  if (!validIdentifier(identifier)) return false;
  confirmedIdentifier = identifier;
  if (installedWindow()) return writeLaunch(BOUND_STORAGE_KEY, identifier);
  if (webKitInstallation()) return true;

  if (!documentToken && !newDocumentToken(identifier)) return false;
  let mapping = readLaunch(TOKEN_STORAGE_PREFIX + documentToken);
  if (mapping.state === "present" && mapping.identifier !== identifier) {
    // A confirmed slot is immutable. A different workspace needs a new manifest.
    if (!newDocumentToken(identifier)) return false;
    mapping = readLaunch(TOKEN_STORAGE_PREFIX + documentToken);
  }
  if (mapping.state !== "absent"
    && !(mapping.state === "present" && mapping.identifier === identifier)) return false;
  const persisted = mapping.state === "present"
    || writeLaunch(TOKEN_STORAGE_PREFIX + documentToken, identifier);
  if (persisted) {
    rememberDocumentToken(identifier);
    exposeManifest();
  }
  return persisted;
}

/** Replace only launch slots belonging to the server-confirmed previous link. */
export async function rotateWorkspaceLaunch(previousAccessHash: string, identifier: string): Promise<boolean> {
  if (!validIdentifier(identifier)) return false;
  let persisted = true;
  try {
    const keys = [BOUND_STORAGE_KEY, ...Object.keys(window.localStorage).filter(key =>
      key.startsWith(TOKEN_STORAGE_PREFIX) && validToken(key.slice(TOKEN_STORAGE_PREFIX.length)))];
    for (const key of keys) {
      const before = readLaunch(key);
      if (before.state === "unavailable") return false;
      if (before.state !== "present" || !before.identifier) continue;
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(`kaigen-workspace-identifier-v1${before.identifier}`)));
      const hash = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (hash !== previousAccessHash) continue;
      // A different tab may have changed this slot while hashing. Never replace it.
      const current = readLaunch(key);
      if (current.state === "present" && current.identifier === before.identifier) {
        persisted = writeLaunch(key, identifier) && persisted;
      }
    }
    confirmedIdentifier = identifier;
    if (installedWindow()) {
      if (readLaunch(BOUND_STORAGE_KEY).state === "absent") {
        persisted = writeLaunch(BOUND_STORAGE_KEY, identifier) && persisted;
      }
      rememberDocumentToken(identifier);
      exposeManifest();
      return persisted;
    }
    return rememberWorkspaceLaunch(identifier) && persisted;
  } catch {
    return false;
  }
}

/** Call only after confirmed destruction; a stale tab must not clear another key. */
export function forgetWorkspaceLaunch(identifier: string): boolean {
  if (!validIdentifier(identifier)) return false;
  if (confirmedIdentifier === identifier) confirmedIdentifier = null;
  let persisted = true;
  try {
    const keys = Object.keys(window.localStorage)
      .filter(key => key.startsWith(TOKEN_STORAGE_PREFIX)
        && validToken(key.slice(TOKEN_STORAGE_PREFIX.length)));
    for (const key of keys) {
      const mapping = readLaunch(key);
      if (mapping.state === "present" && mapping.identifier === identifier) {
        persisted = writeLaunch(key, null) && persisted;
      } else if (mapping.state === "unavailable") persisted = false;
    }
  } catch {
    persisted = false;
  }

  const bound = readLaunch(BOUND_STORAGE_KEY);
  if (bound.state === "present") {
    if (bound.identifier === identifier) {
      persisted = writeLaunch(BOUND_STORAGE_KEY, null) && persisted;
    }
  } else if (installedWindow()
    && fragmentIdentifier(new URL(window.location.href)) === identifier) {
    // Also suppress an install seed when no confirmed binding was persisted.
    persisted = writeLaunch(BOUND_STORAGE_KEY, null) && persisted;
  } else if (bound.state === "unavailable") {
    persisted = false;
  }
  return persisted;
}

/** A user-directed link has priority over a saved launcher target. */
export function canonicalWorkspaceUrl(identifier: string): string {
  if (!validIdentifier(identifier)) throw new Error("INVALID_WORKSPACE_IDENTIFIER");
  const url = new URL(window.location.href);
  url.username = "";
  url.password = "";
  url.searchParams.delete(LAUNCH_PARAMETER);
  url.hash = `k=${identifier}`;
  return url.href;
}

/** Refresh a WebKit install seed after creation, including a failed first login. */
export function needsWorkspaceManifestReload(): boolean {
  return webKitInstallation() && !installedWindow();
}
