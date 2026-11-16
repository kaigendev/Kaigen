const LAUNCH_PARAMETER = "kaigen-launch";
const NOTIFICATION_PARAMETER = "kaigen-notification";
const NOTIFICATION_EVENT_PARAMETER = "kaigen-notification-event";
const NOTIFICATION_STORAGE_PREFIX = "kaigen.web.notification.route.v1.";
const NOTIFICATION_TOKEN_PREFIX = "kaigen.web.notification.token.v1.";
const NOTIFICATION_HINT_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const NOTIFICATION_EVENT_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const DECLARATIVE_NOTIFICATION_MARKER = "1";
const SHARED_INSTALL_STORAGE_KEY = "kaigen.web.launch.bound.v1";
const TOKEN_STORAGE_PREFIX = "kaigen.web.launch.token.v1.";
const HISTORY_FIELD = "kaigenWebLaunch";
const INSTALLATION_HISTORY_FIELD = "kaigenWebInstallation";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{40,80}$/u;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

type LaunchRecord = { v: 1; identifier: string | null };
type DocumentLaunch = { token: string; identifier: string | null };
type InstallationSlot = { v: 1; token: string | null };
type StoredLaunch =
  | { state: "absent" | "invalid" | "unavailable" }
  | { state: "present"; identifier: string | null };

let initialized = false;
let consumedNotificationHint: string | null = null;
let declarativeNotification: { hint: string; event: string } | null = null;
let documentToken: string | null = null;
let confirmedIdentifier: string | null = null;
let installationSlot: InstallationSlot | null = null;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function readNotificationRoute(hint: string): { state: "absent" | "invalid" | "unavailable" } | { state: "present"; token: string } {
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_STORAGE_PREFIX + hint);
    if (raw === null) return { state: "absent" };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("v" in value) || value.v !== 1
      || !("token" in value) || !validToken(value.token)) return { state: "invalid" };
    return { state: "present", token: value.token };
  } catch { return { state: "unavailable" }; }
}

export function pendingNotificationLaunch(): string | null {
  if (declarativeNotification) return declarativeNotification.hint;
  const hints = new URL(window.location.href).searchParams.getAll(NOTIFICATION_PARAMETER);
  return hints.length === 1 && NOTIFICATION_HINT_PATTERN.test(hints[0])
    && hints[0] !== consumedNotificationHint ? hints[0] : null;
}

function notificationEvent(params: URLSearchParams): string | null {
  const events = params.getAll(NOTIFICATION_EVENT_PARAMETER);
  return events.length === 1 && NOTIFICATION_EVENT_PATTERN.test(events[0]) ? events[0] : null;
}

export function pendingNotificationEvent(): string | null {
  return declarativeNotification?.event ?? notificationEvent(new URL(window.location.href).searchParams);
}

export function clearNotificationLaunch(hint: string): void {
  if (pendingNotificationLaunch() !== hint) return;
  const url = new URL(window.location.href);
  consumedNotificationHint = hint;
  declarativeNotification = null;
  url.searchParams.delete(NOTIFICATION_PARAMETER);
  url.searchParams.delete(NOTIFICATION_EVENT_PARAMETER);
  try { replaceDocumentUrl(url); } catch { /* A denied history write retains only the public hint; this document consumed it. */ }
}

function resolveNotificationLaunch(url: URL): boolean {
  const selectors = url.searchParams.getAll(NOTIFICATION_PARAMETER);
  if (!selectors.length) return false;
  const declarative = selectors.length === 1 && selectors[0] === DECLARATIVE_NOTIFICATION_MARKER;
  // A public query marker makes notification activation a document navigation.
  // The sealed event stays in the fragment and is retained only in this document.
  const params = declarative ? new URLSearchParams(url.hash.slice(1)) : url.searchParams;
  const hints = params.getAll(NOTIFICATION_PARAMETER);
  const event = notificationEvent(params);
  const mixed = declarative && (url.searchParams.has(NOTIFICATION_EVENT_PARAMETER)
    || [...params.keys()].some(key => key !== NOTIFICATION_PARAMETER && key !== NOTIFICATION_EVENT_PARAMETER));
  url.hash = "";
  if (declarative) {
    url.searchParams.delete(NOTIFICATION_PARAMETER);
    url.searchParams.delete(NOTIFICATION_EVENT_PARAMETER);
  }
  if (url.pathname === "/" && !url.searchParams.has(LAUNCH_PARAMETER) && !mixed
    && hints.length === 1 && NOTIFICATION_HINT_PATTERN.test(hints[0]) && (!declarative || event)) {
    const route = readNotificationRoute(hints[0]);
    const mapping = route.state === "present" ? readLaunch(NOTIFICATION_TOKEN_PREFIX + route.token) : null;
    if (mapping?.state === "present" && mapping.identifier) {
      url.hash = "k=" + mapping.identifier;
      if (declarative && event) declarativeNotification = { hint: hints[0], event };
      if (installedWindow()) {
        // The routing token NEVER becomes a mutable document/install slot.
        // This window gets a separate ordinary selector, confirmed on lookup.
        const token = newDocumentToken(mapping.identifier);
        if (token) rememberInstallationSlot({ v: 1, token });
      }
    }
  }
  try { replaceDocumentUrl(url); } catch (error) {
    if (!declarative) throw error;
    // If history is restricted, replace only the fragment. The retained query
    // contains the public marker, never the event token.
    const sameQuery = new URL(window.location.href);
    sameQuery.hash = url.hash;
    replaceDocumentUrl(sameQuery);
  }
  return true;
}

/** Call synchronously only with the authenticated current session's identifier. */
export function rememberNotificationRoute(hint: string, identifier: string): boolean {
  if (!NOTIFICATION_HINT_PATTERN.test(hint) || !validIdentifier(identifier)
    || identifier !== confirmedIdentifier) return false;
  const ownKey = installedWindow() ? installationStorageKey() : null;
  if (ownKey) {
    const own = readLaunch(ownKey);
    if (own.state !== "present" || own.identifier !== identifier) return false;
  }
  const route = readNotificationRoute(hint);
  if (route.state === "invalid" || route.state === "unavailable") return false;
  if (route.state === "present") {
    const mapped = readLaunch(NOTIFICATION_TOKEN_PREFIX + route.token);
    // Only authenticated rotation/destruction may maintain this dedicated slot.
    // Neither the original app nor a notification window can rebind it manually.
    return mapped.state === "present" && mapped.identifier === identifier;
  }
  try {
    const token = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
      value => value.toString(16).padStart(2, "0")).join("");
    const key = NOTIFICATION_TOKEN_PREFIX + token;
    if (readLaunch(key).state !== "absent" || !writeLaunch(key, identifier)) return false;
    window.localStorage.setItem(NOTIFICATION_STORAGE_PREFIX + hint, JSON.stringify({ v: 1, token }));
    return true;
  } catch { return false; }
}

function maintainedTokenKey(key: string): boolean {
  return (key.startsWith(TOKEN_STORAGE_PREFIX) && validToken(key.slice(TOKEN_STORAGE_PREFIX.length)))
    || (key.startsWith(NOTIFICATION_TOKEN_PREFIX) && validToken(key.slice(NOTIFICATION_TOKEN_PREFIX.length)));
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

function savedInstallationSlot(): InstallationSlot | null {
  try {
    const state: unknown = window.history.state;
    if (typeof state !== "object" || state === null) return null;
    const value: unknown = (state as Record<string, unknown>)[INSTALLATION_HISTORY_FIELD];
    if (typeof value !== "object" || value === null) return null;
    const slot = value as Partial<InstallationSlot>;
    return slot.v === 1 && (slot.token === null || validToken(slot.token))
      ? { v: 1, token: slot.token } : null;
  } catch {
    return null;
  }
}

function rememberInstallationSlot(slot: InstallationSlot): void {
  installationSlot = slot;
  if (slot.token) documentToken = slot.token;
  try {
    const previous: unknown = window.history.state;
    if (previous !== null && typeof previous !== "object") return;
    // The app's selector survives same-entry manual navigation and rotation.
    // It is independent of the workspace key and never added to shared URLs.
    window.history.replaceState({
      ...previous,
      [INSTALLATION_HISTORY_FIELD]: slot,
    }, "", window.location.href);
  } catch {
    // A denied history write must not prevent ordinary manual authentication.
  }
}

function initializeInstallationSlot(url: URL): void {
  if (url.pathname !== "/") return;
  const markers = url.searchParams.getAll(LAUNCH_PARAMETER);
  if (markers.length === 1 && validToken(markers[0])) {
    // The actual launch URL always wins over a previous history association.
    rememberInstallationSlot({ v: 1, token: markers[0] });
  } else if (markers.length === 1 && markers[0] === "1") {
    rememberInstallationSlot({ v: 1, token: null });
  } else if (markers.length === 0) {
    const saved = savedInstallationSlot();
    if (saved) rememberInstallationSlot(saved);
  }
}

function installationStorageKey(): string | null {
  if (!installationSlot) return null;
  return installationSlot.token
    ? TOKEN_STORAGE_PREFIX + installationSlot.token : SHARED_INSTALL_STORAGE_KEY;
}

function fragmentIdentifier(url: URL): string | null {
  return /^#(?:k=)?([A-Za-z0-9_-]{40,80})$/u.exec(url.hash)?.[1] ?? null;
}

function replaceDocumentUrl(url: URL): void {
  if (url.href !== window.location.href) {
    // The password-required fallback belongs to this history entry.
    let state: unknown = null;
    try {
      state = window.history.state;
    } catch {
      // A denied read must not discard a known app selector or block bootstrap.
      if (installationSlot) state = { [INSTALLATION_HISTORY_FIELD]: installationSlot };
    }
    try {
      window.history.replaceState(state, "", url.href);
    } catch {
      const current = new URL(window.location.href);
      if (url.origin === current.origin && url.pathname === current.pathname
        && url.search === current.search) {
        // Installed resolution changes only the fragment. The Location setter
        // is synchronous, so React cannot consume a tombstoned or foreign seed.
        try {
          window.location.hash = url.hash;
          if (new URL(window.location.href).hash === url.hash) return;
        } catch {
          // Both supported URL update routes are unavailable in this context.
        }
      } else if (!installedWindow() && webKitInstallation()
        && url.origin === current.origin && url.pathname === current.pathname
        && url.hash === current.hash
        && url.searchParams.getAll(LAUNCH_PARAMETER).length === 1
        && url.searchParams.get(LAUNCH_PARAMETER) === "1") {
        const before = new URL(current.href);
        const after = new URL(url.href);
        before.searchParams.delete(LAUNCH_PARAMETER);
        after.searchParams.delete(LAUNCH_PARAMETER);
        if (before.href === after.href) {
          try {
            // Preserve the same WebKit seed. The next document already has
            // marker1, so denied history writes cannot cause a reload loop.
            window.location.replace(url.href);
            return;
          } catch {
            // A blocked normal navigation is an explicit platform boundary.
          }
        }
      }
      throw new Error("WEB_LAUNCH_NAVIGATION_UNAVAILABLE");
    }
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
  try {
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
  } catch {
    // A denied history read cannot select another app's binding or block entry.
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
  const notificationLaunch = resolveNotificationLaunch(url);
  const marker = url.searchParams.getAll(LAUNCH_PARAMETER);
  const token = marker.length === 1 && validToken(marker[0]) ? marker[0] : null;
  const launchEntry = url.pathname === "/" && ((marker.length === 1
    && (marker[0] === "1" || token !== null)) || (!url.hash && marker.length === 0));
  const seed = fragmentIdentifier(url);

  if (installed && !notificationLaunch) initializeInstallationSlot(url);

  // Explicit unmarked links and malformed fragments are never replaced by a
  // remembered key. A launcher resolves only its own document's local mapping.
  if (!notificationLaunch && installed && launchEntry && (!url.hash || seed)) {
    if (token) {
      const mapping = readLaunch(TOKEN_STORAGE_PREFIX + token);
      // An explicit selector owns exactly one slot. Missing, denied and
      // tombstoned slots never revive a seed or use the shared install record.
      url.hash = mapping.state === "present" && mapping.identifier
        ? `k=${mapping.identifier}` : "";
    } else {
      const key = installationStorageKey();
      const bound = key ? readLaunch(key) : null;
      if (bound?.state === "present") {
        // A null record is a tombstone: never revive the shortcut's old seed.
        url.hash = bound.identifier ? `k=${bound.identifier}` : "";
      }
    }
    replaceDocumentUrl(url);
  } else if (!notificationLaunch && !installed && webKit) {
    // WebKit snapshots the document URL when start_url is omitted. Mark that
    // install seed before exposing the manifest, without putting its key in it.
    url.searchParams.set(LAUNCH_PARAMETER, "1");
    replaceDocumentUrl(url);
  }

  if (!webKit) {
    if (installed && installationSlot?.token) documentToken = installationSlot.token;
    else initializeDocumentToken(fragmentIdentifier(url));
  }
  exposeManifest();
  window.addEventListener("appinstalled", () => {
    // Installation can transfer this document into an app window. Preserve an
    // existing binding, and never turn a blank installation into a tombstone.
    if (!confirmedIdentifier) return;
    const nowInstalled = installedWindow();
    const current = new URL(window.location.href);
    const markers = current.searchParams.getAll(LAUNCH_PARAMETER);
    if (!installed && nowInstalled && !installationSlot && current.pathname === "/") {
      // A transferred Chromium document owns the selector exposed by its
      // manifest, not an old selector that may remain in its ordinary URL.
      if (!webKitInstallation() && documentToken) {
        rememberInstallationSlot({ v: 1, token: documentToken });
      } else if (markers.length === 1 && markers[0] === "1") {
        rememberInstallationSlot({ v: 1, token: null });
      }
    }
    const key = nowInstalled ? installationStorageKey() : null;
    if (key && readLaunch(key).state === "absent") {
      writeLaunch(key, confirmedIdentifier);
    }
  });
}

/** Call only after the server confirms creation or lookup of this workspace. */
export function rememberWorkspaceLaunch(identifier: string): boolean {
  if (!validIdentifier(identifier)) return false;
  confirmedIdentifier = identifier;
  if (installedWindow()) {
    const key = installationStorageKey();
    if (!key || !installationSlot) return false;
    rememberInstallationSlot(installationSlot);
    const persisted = writeLaunch(key, identifier);
    if (persisted) rememberDocumentToken(identifier);
    return persisted;
  }
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
export async function rotateWorkspaceLaunch(previousAccessHash: string, identifier: string, assertCurrent?: () => void): Promise<boolean> {
  if (!validIdentifier(identifier)) return false;
  assertCurrent?.();
  let persisted = true;
  try {
    const keys = [SHARED_INSTALL_STORAGE_KEY, ...Object.keys(window.localStorage).filter(maintainedTokenKey)];
    for (const key of keys) {
      const before = readLaunch(key);
      if (before.state === "unavailable") return false;
      if (before.state !== "present" || !before.identifier) continue;
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(`kaigen-workspace-identifier-v1${before.identifier}`)));
      assertCurrent?.();
      const hash = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (hash !== previousAccessHash) continue;
      // A different tab may have changed this slot while hashing. Never replace it.
      const current = readLaunch(key);
      if (current.state === "present" && current.identifier === before.identifier) {
        persisted = writeLaunch(key, identifier) && persisted;
      }
    }
    assertCurrent?.();
    confirmedIdentifier = identifier;
    if (installedWindow()) {
      const key = installationStorageKey();
      if (!key) return false;
      let ownMapping = readLaunch(key);
      if (ownMapping.state === "absent") {
        persisted = writeLaunch(key, identifier) && persisted;
        ownMapping = readLaunch(key);
      }
      // Matching-slot maintenance may skip a changed, denied or tombstoned
      // current slot. Never report that slot persisted or revive it implicitly.
      if (ownMapping.state !== "present" || ownMapping.identifier !== identifier) return false;
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
    const keys = Object.keys(window.localStorage).filter(maintainedTokenKey);
    for (const key of keys) {
      const mapping = readLaunch(key);
      if (mapping.state === "present" && mapping.identifier === identifier) {
        persisted = writeLaunch(key, null) && persisted;
      } else if (mapping.state === "unavailable") persisted = false;
    }
  } catch {
    persisted = false;
  }

  const bound = readLaunch(SHARED_INSTALL_STORAGE_KEY);
  if (bound.state === "present") {
    if (bound.identifier === identifier) {
      persisted = writeLaunch(SHARED_INSTALL_STORAGE_KEY, null) && persisted;
    }
  } else if (installedWindow()
    && installationStorageKey() === SHARED_INSTALL_STORAGE_KEY
    && fragmentIdentifier(new URL(window.location.href)) === identifier) {
    // Also suppress an install seed when no confirmed binding was persisted.
    persisted = writeLaunch(SHARED_INSTALL_STORAGE_KEY, null) && persisted;
  } else if (bound.state === "unavailable") {
    persisted = false;
  }
  const key = installedWindow() ? installationStorageKey() : null;
  if (key && key !== SHARED_INSTALL_STORAGE_KEY
    && fragmentIdentifier(new URL(window.location.href)) === identifier) {
    const mapping = readLaunch(key);
    if (mapping.state === "absent" || mapping.state === "invalid") {
      persisted = writeLaunch(key, null) && persisted;
    } else if (mapping.state === "unavailable") persisted = false;
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
  url.searchParams.delete(NOTIFICATION_PARAMETER);
  url.searchParams.delete(NOTIFICATION_EVENT_PARAMETER);
  url.hash = `k=${identifier}`;
  return url.href;
}

/** Refresh a WebKit install seed after creation, including a failed first login. */
export function needsWorkspaceManifestReload(): boolean {
  return webKitInstallation() && !installedWindow();
}
