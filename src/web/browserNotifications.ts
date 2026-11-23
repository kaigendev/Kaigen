import { parseChatNotificationTarget } from "../chatNotificationTarget";
import type { ChatNotificationTarget } from "../chatNotificationTarget";
import { NOTIFICATION_OPEN_EVENT, NOTIFICATION_VIEW_EVENT, NOTIFICATION_VIEW_QUERY_EVENT } from "../desktopNotifications";
import { webSession } from "./session";
import { clearNotificationLaunch, pendingNotificationEvent, pendingNotificationLaunch, rememberNotificationRoute } from "./workspaceLaunch";

type WorkerAttempt = { promise: Promise<WorkerLease>; registration?: ServiceWorkerRegistration; settled: boolean };
type WorkerLease = { attempt: WorkerAttempt; registration: ServiceWorkerRegistration };
let worker: WorkerAttempt | undefined;
const PUSH_STAGE_TIMEOUT_MS = 20_000;
type ScriptPolicy = { createScriptURL: (value: string) => unknown };
let scriptPolicy: ScriptPolicy | undefined;

function workerScriptUrl() {
  const path = new URL("/kaigen-notifications-sw.js", location.origin).href;
  const factory = (globalThis as typeof globalThis & { trustedTypes?: { createPolicy: (name: string, rules: { createScriptURL: (value: string) => string }) => ScriptPolicy } }).trustedTypes;
  if (!factory) return path;
  scriptPolicy ??= factory.createPolicy("kaigen-notifications-worker", { createScriptURL: (value) => {
    if (value !== path) throw new TypeError("Unexpected notification worker URL");
    return path;
  } });
  return scriptPolicy.createScriptURL(path) as string;
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  return window.isSecureContext && "Notification" in window ? Notification.permission : "unsupported";
}

function activeRegistration(registration: ServiceWorkerRegistration) {
  return registration.active?.state === "activated";
}
function notificationWorkerLease(): Promise<WorkerLease> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return Promise.reject(new Error("WEB_NOTIFICATIONS_UNAVAILABLE"));
  if (worker?.settled && worker.registration && !activeRegistration(worker.registration)) worker = undefined;
  if (worker) return worker.promise;
  const attempt = { settled: false } as WorkerAttempt;
  worker = attempt;
  attempt.promise = new Promise<WorkerLease>((resolve, reject) => {
    let finished = false;
    const removers: Array<() => void> = [], observed = new Set<ServiceWorker>();
    const timer = setTimeout(() => finish(new Error("WEB_NOTIFICATION_WORKER_TIMEOUT")), PUSH_STAGE_TIMEOUT_MS);
    const finish = (error?: unknown, registration?: ServiceWorkerRegistration) => {
      if (finished) return;
      finished = true; attempt.settled = true; clearTimeout(timer); removers.forEach(remove => remove());
      if (error) reject(error);
      else if (worker !== attempt || !registration) reject(new Error("NOTIFICATION_OPERATION_SUPERSEDED"));
      else resolve({ attempt, registration });
    };
    try {
      // Use this register result, never a memoized ready Promise from an older registration.
      void navigator.serviceWorker.register(workerScriptUrl(), { scope: "/", updateViaCache: "none" }).then(registration => {
        if (finished) return; // Native register cannot be canceled; discard its late result.
        attempt.registration = registration;
        const check = () => {
          if (finished) return;
          if (activeRegistration(registration)) { finish(undefined, registration); return; }
          for (const candidate of [registration.installing, registration.waiting, registration.active]) {
            if (!candidate || observed.has(candidate)) continue;
            observed.add(candidate); candidate.addEventListener("statechange", check);
            removers.push(() => candidate.removeEventListener("statechange", check));
          }
        };
        registration.addEventListener("updatefound", check);
        removers.push(() => registration.removeEventListener("updatefound", check));
        check();
      }, error => finish(error));
    } catch (error) { finish(error); }
  }).catch((error: unknown) => { if (worker === attempt) worker = undefined; throw error; });
  return attempt.promise;
}
export function notificationWorker() { return notificationWorkerLease().then(lease => lease.registration); }
function invalidWorker(lease: WorkerLease, error: unknown) {
  return !activeRegistration(lease.registration)
    || (error instanceof DOMException && error.name === "InvalidStateError")
    || (error instanceof Error && (error.message === "WEB_PUSH_OPERATION_TIMEOUT" || error.message === "WEB_NOTIFICATION_WORKER_TIMEOUT" || error.message === "WEB_NOTIFICATION_WORKER_INACTIVE" || error.message === "WEB_NOTIFICATION_WORKER_SUPERSEDED"));
}
function invalidateWorker(lease: WorkerLease, error: unknown, state?: PushState) {
  if (!invalidWorker(lease, error)) return false;
  if (worker === lease.attempt) worker = undefined;
  if (state?.workerLease === lease) { state.workerLease = undefined; state.registration = null; }
  return true;
}
function finitePushPromise<T>(operation: Promise<T>, signal?: AbortSignal, onTimeout?: (error: Error) => void, timeoutMs: number | null = PUSH_STAGE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal?.reason ?? new Error("NOTIFICATION_OPERATION_SUPERSEDED"));
    if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true });
    if (timeoutMs !== null) timer = setTimeout(() => { const error = new Error("WEB_PUSH_OPERATION_TIMEOUT"); reject(error); onTimeout?.(error); }, timeoutMs);
  });
  return Promise.race([operation, stopped]).finally(() => { clearTimeout(timer); if (aborted) signal?.removeEventListener("abort", aborted); });
}

function waitForPushConsent(operation: Promise<PushSubscription>, signal: AbortSignal): Promise<PushSubscription> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(signal.reason ?? new Error("NOTIFICATION_OPERATION_SUPERSEDED")));
    signal.addEventListener("abort", abort, { once: true });
    // Native settlement is authoritative; permission snapshots can precede a late OS prompt.
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

export async function displayBrowserNotification(options: { title: string; body?: string }) {
  if (browserNotificationPermission() !== "granted") return;
  const registration = await notificationWorker();
  await registration.showNotification(options.title, { body: options.body, icon: "/kaigen-icon.png", tag: "kaigen-events" });
}

/** Open the authenticated destination for a service worker click or installed launch. */
let notificationClientRevision = 0;
let notificationClientRoute: { session: NotificationSession; routingHint: string; registration: ServiceWorkerRegistration } | undefined;
function publishNotificationClientRoute() {
  const route = notificationClientRoute;
  if (!route || !route.session.isCurrent()) return;
  const standalone = matchMedia("(display-mode: standalone)").matches
    || matchMedia("(display-mode: minimal-ui)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const message = { type: "kaigen-notification-client-bind", revision: ++notificationClientRevision, routingHint: route.routingHint, standalone };
  for (const target of new Set([navigator.serviceWorker.controller, route.registration.active])) {
    try { target?.postMessage(message); } catch { /* The next controller/focus/config refresh retries. */ }
  }
}
function rememberNotificationClientRoute(session: NotificationSession, routingHint: string, registration: ServiceWorkerRegistration) {
  if (!session.isCurrent() || !/^[A-Za-z0-9_-]{22}$/u.test(routingHint)) return;
  notificationClientRoute = { session, routingHint, registration };
  publishNotificationClientRoute();
}
function retireNotificationClientRoute() {
  const route = notificationClientRoute;
  notificationClientRoute = undefined;
  const message = { type: "kaigen-notification-client-retire", revision: ++notificationClientRevision };
  for (const target of new Set([navigator.serviceWorker.controller, route?.registration.active])) {
    try { target?.postMessage(message); } catch { /* No authorization is kept in the worker. */ }
  }
}

export function bindBrowserNotificationClicks() {
  if (!("serviceWorker" in navigator)) return () => {};
  let alive = true;
  let pendingEpoch = "";
  const open = (routingHint: unknown, eventToken: unknown, fromLaunch = false) => {
    if (typeof routingHint !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(routingHint)) return;
    const session = webSession.captureNotificationSession();
    if (!session) return; // Keep the URL hint through password authentication.
    if (fromLaunch && pendingEpoch === session.epoch) return;
    if (fromLaunch) pendingEpoch = session.epoch;
    void webSession.command<{ matched: boolean; target: { profileId: string; target: string } | null }>("web_push_target", { routingHint, eventToken }).then(value => {
      if (!alive || !session.isCurrent() || !value.matched
        || (fromLaunch && (pendingNotificationLaunch() !== routingHint || pendingNotificationEvent() !== eventToken))) return;
      const target = parseChatNotificationTarget(JSON.stringify({ ...value.target, createdAt: Date.now() }), Date.now());
      if (target) {
        sessionStorage.setItem("kaigen-open-unread-target", JSON.stringify(target));
        window.dispatchEvent(new Event(NOTIFICATION_OPEN_EVENT));
      }
      if (fromLaunch) clearNotificationLaunch(routingHint);
    }).catch(() => {}).finally(() => { if (fromLaunch && pendingEpoch === session.epoch) pendingEpoch = ""; });
  };
  const resume = () => {
    if (notificationClientRoute && !notificationClientRoute.session.isCurrent()) retireNotificationClientRoute();
    else publishNotificationClientRoute();
    const hint = pendingNotificationLaunch(); if (hint) open(hint, pendingNotificationEvent(), true);
  };
  const handle = (event: MessageEvent) => {
    if (event.source !== navigator.serviceWorker.controller || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "kaigen-notification-query") {
      const session = webSession.captureNotificationSession();
      if (!session) { event.ports[0]?.postMessage({ matched: false }); return; }
      const { routingHint, eventToken } = event.data;
      void webSession.command<{ matched: boolean; target: unknown }>("web_push_target", { routingHint, eventToken })
        .then(value => event.ports[0]?.postMessage({ matched: alive && session.isCurrent()
          && value.matched && (eventToken == null || value.target != null) }))
        .catch(() => event.ports[0]?.postMessage({ matched: false }));
      return;
    }
    if (event.data.type === "kaigen-notification-open") open(event.data.routingHint, event.data.eventToken);
  };
  navigator.serviceWorker.addEventListener("message", handle);
  navigator.serviceWorker.addEventListener("controllerchange", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  const stopWorkspace = webSession.onWorkspace(resume);
  const stopSession = webSession.onSessionUnavailable(retireNotificationClientRoute);
  resume();
  return () => {
    alive = false; stopWorkspace(); stopSession(); retireNotificationClientRoute();
    navigator.serviceWorker.removeEventListener("message", handle);
    navigator.serviceWorker.removeEventListener("controllerchange", resume);
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", resume);
  };
}

export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0));
}

export type BrowserNotificationViewTarget = Pick<ChatNotificationTarget, "profileId" | "target">;
export function parseBrowserNotificationViewTarget(value: unknown): BrowserNotificationViewTarget | null {
  if (!value || typeof value !== "object") return null;
  const { profileId, target } = value as Partial<BrowserNotificationViewTarget>;
  if (typeof profileId !== "string" || profileId.length > 128 || typeof target !== "string") return null;
  const now = Date.now();
  const parsed = parseChatNotificationTarget(JSON.stringify({ profileId, target, createdAt: now }), now);
  return parsed ? { profileId: parsed.profileId, target: parsed.target === "requests" ? "requests" : "friend-key:" + parsed.target.slice(11).toUpperCase() } : null;
}

let notificationViewTab: string | undefined;
let notificationViewRevision = 0;
const PUSH_VIEW_REFRESH_EVENT = "kaigen-push-view-refresh";
/** One authenticated page reports its current target; nothing is stored locally. */
export function bindBrowserNotificationView() {
  if (!window.isSecureContext || typeof crypto.randomUUID !== "function") return () => {};
  notificationViewTab ??= crypto.randomUUID();
  const tabId = notificationViewTab;
  let target: BrowserNotificationViewTarget | null = null;
  let alive = true, suspended = false, epoch = "";
  let lastView = "", lastSentAt = 0;
  let pending: AbortController | undefined;
  const send = (clear = false) => {
    if (!alive) return;
    const session = webSession.captureNotificationSession();
    if (!session) return;
    const view = !clear && !suspended && document.visibilityState === "visible" && document.hasFocus() ? target : null;
    const viewKey = JSON.stringify(view), now = performance.now();
    if (epoch === session.epoch && lastView === viewKey && now - lastSentAt < 9_000) return;
    epoch = session.epoch; lastView = viewKey; lastSentAt = now;
    pending?.abort();
    const controller = new AbortController(); pending = controller;
    const request = webSession.command("web_push_view", { tabId, revision: ++notificationViewRevision, view }, { signal: controller.signal });
    void finitePushPromise(request, controller.signal, () => controller.abort(), 10_000)
      .catch(() => { /* Expiry restores delivery if this page can no longer report its view. */ })
      .finally(() => { if (pending === controller) pending = undefined; });
  };
  const changed = (event: Event) => { target = parseBrowserNotificationViewTarget((event as CustomEvent<unknown>).detail); send(); };
  const refresh = () => { window.dispatchEvent(new Event(NOTIFICATION_VIEW_QUERY_EVENT)); send(); };
  const hide = () => { suspended = true; send(true); };
  const show = () => { suspended = false; refresh(); };
  const rebound = () => { lastView = ""; refresh(); };
  const stopWorkspace = webSession.onWorkspace(() => {
    const session = webSession.captureNotificationSession();
    if (session && session.epoch !== epoch) refresh();
  });
  const stopSession = webSession.onSessionUnavailable(() => { pending?.abort(); epoch = ""; target = null; });
  window.addEventListener(NOTIFICATION_VIEW_EVENT, changed);
  window.addEventListener(PUSH_VIEW_REFRESH_EVENT, rebound);
  window.addEventListener("focus", refresh); window.addEventListener("blur", refresh);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
  const timer = setInterval(() => {
    if (!suspended && document.visibilityState === "visible" && document.hasFocus()) refresh();
  }, 10_000);
  refresh();
  return () => {
    send(true); alive = false; clearInterval(timer); stopWorkspace(); stopSession();
    window.removeEventListener(NOTIFICATION_VIEW_EVENT, changed);
    window.removeEventListener(PUSH_VIEW_REFRESH_EVENT, rebound);
    window.removeEventListener("focus", refresh); window.removeEventListener("blur", refresh);
    document.removeEventListener("visibilitychange", refresh);
    window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
  };
}


export const NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE = "WEB_PUSH_NATIVE_SUBSCRIPTION_UNAVAILABLE";
type PushError = boolean | typeof NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE;
export type BrowserPushFailure = {
  stage: "session" | "worker" | "configuration" | "storage" | "subscription" | "registration";
  code: string;
};
function pushFailure(stage: BrowserPushFailure["stage"], error: unknown): BrowserPushFailure {
  // Keep useful diagnostics without exposing URLs, credentials or storage values.
  const codes = new Set(["WEB_PUSH_OPERATION_TIMEOUT", "WEB_NOTIFICATION_WORKER_TIMEOUT", "WEB_NOTIFICATIONS_UNAVAILABLE",
    "WEB_NOTIFICATION_WORKER_INACTIVE", "WEB_NOTIFICATION_WORKER_SUPERSEDED", "WEB_NOTIFICATION_ROUTE_UNAVAILABLE",
    "WEB_PUSH_UNAVAILABLE", "WEB_PUSH_INTENT_CHANGED", "WEB_PUSH_ENDPOINT_EXPIRED", "WEB_PUSH_REENABLE_REQUIRED",
    "UI_LEASE_TRANSFERRED", "AUTH_INVALID", "CSRF_INVALID", "DEVICE_AUTH_INVALID", "SESSION_NOT_ACTIVE"]);
  const names = new Set(["NotAllowedError", "SecurityError", "InvalidStateError", "AbortError", "TypeError"]);
  const code = error instanceof Error && codes.has(error.message) ? error.message
    : error instanceof Error && names.has(error.name) ? error.name : "UNAVAILABLE";
  return { stage, code };
}

function serializePushSubscription(subscription: PushSubscription): PushSubscriptionJSON {
  const data = subscription.toJSON();
  const { endpoint, keys } = data;
  let url: URL | undefined;
  try { if (endpoint) url = new URL(endpoint); } catch { /* No usable endpoint. */ }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || endpoint !== subscription.endpoint
    || !keys || !/^[A-Za-z0-9_-]{87}$/u.test(keys.p256dh ?? "")
    || applicationServerKey(keys.p256dh)[0] !== 4 || !/^[A-Za-z0-9_-]{22}$/u.test(keys.auth ?? "")) {
    throw new Error(NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE);
  }
  return data;
}

function nativePushSubscriptionUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE;
}

type NotificationSession = NonNullable<ReturnType<typeof webSession.captureNotificationSession>>;
type PushConfig = { routingHint: string; publicKey: string; enabled: boolean; intentEnabled?: boolean; needsRebind?: boolean; endpointRejected?: boolean; intentRevision?: string };
type BrowserPushEnableFailure = "enableFailed" | "reenableRequired" | "nativeSubscriptionUnavailable";
type PushState = {
  namespace: string; controlFences: Set<string>; language: "ru" | "en"; intent: boolean | undefined; decision: string | null; pendingEnable: boolean; revision: number; enabled: boolean;
  consentRevision?: number;
  enableFailure?: { epoch: string; revision: number; status: BrowserPushEnableFailure };
  registration: ServiceWorkerRegistration | null; workerLease?: WorkerLease; publicKey: string; busy: number; preparing: number; error: PushError; failure?: BrowserPushFailure;
  listeners: Set<() => void>; pending?: { epoch: string; language: string; revision: number; promise: Promise<void> };
  retryTimer?: ReturnType<typeof setTimeout>; retries: number;
};
type PushBinding = { session: NotificationSession; state: PushState };
export type BrowserPushView = {
  registration: ServiceWorkerRegistration | null; publicKey: string; enabled: boolean;
  busy: boolean; controlBusy?: boolean; consentPending?: boolean; error: PushError; optedIn?: boolean; binding?: PushBinding; failure?: BrowserPushFailure; enableFailure?: BrowserPushEnableFailure; retry?: () => void;
};
const pushStates = new Map<string, PushState>();
let pushQueue: Promise<unknown> = Promise.resolve();
function queuePush<T>(action: () => Promise<T>): Promise<T> {
  const result = pushQueue.then(action);
  pushQueue = result.catch(() => {});
  return result;
}
function publishPush(state: PushState) { for (const listener of state.listeners) listener(); }
function retainPushEnableFailure(binding: PushBinding, revision: number, error: unknown) {
  if (!binding.session.isCurrent() || binding.state.revision !== revision
    || (error instanceof Error && error.message === "NOTIFICATION_OPERATION_SUPERSEDED")) return;
  // UI feedback survives readiness refresh and a settings-control remount, but
  // never crosses an authorization epoch or a newer explicit intent decision.
  binding.state.enableFailure = { epoch: binding.session.epoch, revision,
    status: nativePushSubscriptionUnavailable(error) ? "nativeSubscriptionUnavailable"
      : error instanceof Error && error.message === "WEB_PUSH_REENABLE_REQUIRED" ? "reenableRequired" : "enableFailed" };
}
type PushDecision = { enabled: boolean | null; decision: string | null; pendingEnable: boolean };
/** Validate the saved preference and the nonce for the latest local decision, if any. */
function parsePushDecision(value: string | null): PushDecision | undefined {
  if (!value) return undefined;
  try {
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== "object" || !("enabled" in record) || !("decision" in record) || !("pendingEnable" in record)) return undefined;
    const { enabled, decision, pendingEnable } = record;
    if (enabled !== null && typeof enabled !== "boolean") return undefined;
    if (decision !== null && (typeof decision !== "string" || !/^[a-f0-9-]{36}$/u.test(decision))) return undefined;
    if (typeof pendingEnable !== "boolean" || (pendingEnable && decision === null)) return undefined;
    return { enabled, decision, pendingEnable };
  } catch { return undefined; }
}
function persistPushDecision(state: PushState) {
  try {
    // One atomic record binds the confirmed preference to its decision nonce.
    localStorage.setItem("kaigen-notification-intent-v1:" + state.namespace,
      JSON.stringify({ enabled: state.intent ?? null, decision: state.decision, pendingEnable: state.pendingEnable }));
  } catch { /* Memory consent still applies; unavailable storage never creates consent. */ }
}
function rememberPushIntent(state: PushState, enabled: boolean) {
  state.intent = enabled;
  state.pendingEnable = false;
  persistPushDecision(state);
}
function beginPushDecision(state: PushState, enabled?: boolean) {
  state.enableFailure = undefined;
  state.decision = crypto.randomUUID();
  state.pendingEnable = enabled === undefined;
  if (enabled !== undefined) state.intent = enabled;
  state.revision += 1;
  // Enable records the new user decision immediately but retains the previous
  // confirmed value until server success. Disable records false immediately.
  persistPushDecision(state);
  return state.revision;
}
function pushState(namespace: string): PushState {
  let state = pushStates.get(namespace);
  if (state) return state;
  let saved: PushDecision | undefined;
  try { saved = parsePushDecision(localStorage.getItem("kaigen-notification-intent-v1:" + namespace)); }
  catch { /* Unknown stays unknown. */ }
  state = { namespace, controlFences: new Set(), language: "ru", intent: saved?.enabled ?? undefined, decision: saved?.decision ?? null, pendingEnable: saved?.pendingEnable ?? false, revision: 0, enabled: false, registration: null, publicKey: "", busy: 0, preparing: 0, error: false, listeners: new Set(), retries: 0 };
  pushStates.set(namespace, state);
  return state;
}
function reloadPushIntent(state: PushState) {
  try {
    const saved = parsePushDecision(localStorage.getItem("kaigen-notification-intent-v1:" + state.namespace));
    if (saved && ((saved.enabled ?? undefined) !== state.intent || saved.decision !== state.decision || saved.pendingEnable !== state.pendingEnable)) {
      state.intent = saved.enabled ?? undefined; state.decision = saved.decision; state.pendingEnable = saved.pendingEnable; state.revision += 1;
      if (state.intent === false) state.enabled = false;
      publishPush(state);
    }
  } catch { /* Keep known memory consent; never infer consent from storage failure. */ }
}
function pushIntentChanged(error: unknown) {
  return error instanceof Error && error.message === "WEB_PUSH_INTENT_CHANGED";
}
async function refreshPushConflict(binding: PushBinding, revision: number): Promise<boolean> {
  if (!binding.session.isCurrent() || binding.state.revision !== revision) return false;
  const state = binding.state;
  try {
    reloadPushIntent(state); assertPushBinding(binding, revision);
    const lease = state.intent === false && !state.pendingEnable ? undefined : state.workerLease;
    const subscription = lease ? await browserPushStage(binding, revision, lease, () => lease.registration.pushManager?.getSubscription() ?? Promise.resolve(null)) : null;
    const config = await pushCommand<PushConfig>(binding, revision, "web_push_config", { endpoint: subscription?.endpoint ?? null });
    reloadPushIntent(state); assertPushBinding(binding, revision);
    if (!state.pendingEnable && config.intentEnabled === false && (config.intentRevision ?? "0") !== "0") rememberPushIntent(state, false);
    state.enabled = state.pendingEnable ? config.enabled : state.intent === false ? false : config.enabled;
    state.publicKey = config.publicKey;
    const confirmed = !state.pendingEnable && ((state.intent === false && config.intentEnabled === false && controlFences(state).length === 0) || (state.intent === true && config.enabled));
    state.error = !confirmed; publishPush(state);
    return confirmed;
  } catch { /* Fresh metadata failure is bounded; retry only through normal consent-aware reconciliation. */ }
  reloadPushIntent(state);
  if (binding.session.isCurrent() && state.revision === revision) { state.error = true; publishPush(state); }
  return false;
}
function assertPushBinding(binding: PushBinding, revision?: number) {
  if (!binding.session.isCurrent() || (revision !== undefined && binding.state.revision !== revision)) throw new Error("NOTIFICATION_OPERATION_SUPERSEDED");
}
async function pushStage<T>(binding: PushBinding, revision: number, start: (signal: AbortSignal) => Promise<T>, timeoutMs?: number | null): Promise<T> {
  reloadPushIntent(binding.state); assertPushBinding(binding, revision);
  const controller = new AbortController();
  const check = () => {
    if (!binding.session.isCurrent() || binding.state.revision !== revision) controller.abort(new Error("NOTIFICATION_OPERATION_SUPERSEDED"));
  };
  binding.state.listeners.add(check);
  const stopWorkspace = webSession.onWorkspace(check), stopSession = webSession.onSessionUnavailable(check);
  const retire = () => controller.abort(new Error("NOTIFICATION_OPERATION_SUPERSEDED"));
  window.addEventListener("beforeunload", retire);
  window.addEventListener("pagehide", retire);
  try {
    check(); if (controller.signal.aborted) throw controller.signal.reason;
    const value = await finitePushPromise(start(controller.signal), controller.signal, error => controller.abort(error), timeoutMs);
    reloadPushIntent(binding.state); assertPushBinding(binding, revision);
    return value;
  } finally {
    window.removeEventListener("beforeunload", retire);
    window.removeEventListener("pagehide", retire);
    binding.state.listeners.delete(check); stopWorkspace(); stopSession();
  }
}
function assertWorkerLease(lease: WorkerLease, state: PushState) {
  if (worker === lease.attempt && activeRegistration(lease.registration)) return;
  const error = new Error("WEB_NOTIFICATION_WORKER_SUPERSEDED");
  invalidateWorker(lease, error, state); throw error;
}
async function browserPushStage<T>(binding: PushBinding, revision: number, lease: WorkerLease, start: (signal: AbortSignal) => Promise<T>, timeoutMs?: number | null) {
  try {
    assertWorkerLease(lease, binding.state);
    const result = await pushStage(binding, revision, start, timeoutMs);
    if (worker !== lease.attempt || !activeRegistration(lease.registration)) throw new Error("WEB_NOTIFICATION_WORKER_SUPERSEDED");
    return result;
  } catch (error) { invalidateWorker(lease, error, binding.state); throw error; }
}
async function removeRejectedBrowserSubscription(binding: PushBinding, revision: number, lease: WorkerLease, endpoint: string) {
  const push = lease.registration.pushManager;
  const current = await browserPushStage(binding, revision, lease, () => push.getSubscription());
  if (current?.endpoint !== endpoint) return current;
  await browserPushStage(binding, revision, lease, () => current.unsubscribe());
  const remaining = await browserPushStage(binding, revision, lease, () => push.getSubscription());
  if (remaining?.endpoint === endpoint) throw new Error("WEB_PUSH_ENDPOINT_EXPIRED");
  return remaining;
}

function controlFenceKey(state: PushState) { return "kaigen-notification-control-v1:" + state.namespace; }
function controlFences(state: PushState): string[] {
  // Local uncertainty survives a failed write even if an older resolved marker
  // remains readable. At most one local plus one remote token is returned.
  const pending = new Set(state.controlFences);
  try {
    const saved = localStorage.getItem(controlFenceKey(state));
    const acknowledged = localStorage.getItem(controlFenceKey(state) + ":ack");
    if (saved && saved !== acknowledged) pending.add(saved);
  } catch { /* Keep document-local uncertainty independently of storage. */ }
  return [...pending];
}
function addControlFence(state: PushState): string {
  const token = crypto.randomUUID();
  // One uncertainty slot per workspace. A later marker conservatively covers
  // every earlier attempt; it never changes the separate consent decision.
  state.controlFences.clear(); state.controlFences.add(token);
  try { localStorage.setItem(controlFenceKey(state), token); } catch { /* Memory-only. */ }
  return token;
}
function clearControlFences(state: PushState, tokens: readonly string[]) {
  const acknowledged = tokens[tokens.length - 1];
  if (!acknowledged) return;
  state.controlFences.delete(acknowledged);
  // Never remove/overwrite the uncertainty slot: another tab can replace it
  // between a read and a write. An independent ACK slot matches only this
  // successful operation's unique token; newer markers therefore survive.
  try { localStorage.setItem(controlFenceKey(state) + ":ack", acknowledged); }
  catch { /* Retention causes conservative opt-out fencing only. */ }
}
function pushCommand<T = unknown>(binding: PushBinding, revision: number, command: string, args: Record<string, unknown>) {
  const mutation = command === "web_push_subscribe" || command === "web_push_unsubscribe";
  if (!mutation) return pushStage(binding, revision, signal => webSession.command<T>(command, args, { signal }));
  let own: string | undefined, covered: string[] = [];
  return pushStage(binding, revision, signal => {
    // Separate bounded metadata cannot overwrite a newer consent nonce.
    covered = controlFences(binding.state); own = addControlFence(binding.state); covered.push(own);
    return webSession.command<T>(command, args, { signal });
  }).then(value => { clearControlFences(binding.state, covered); return value; }, error => {
    // Only an acknowledged advancing mutation resolves uncertainty.
    // A rejected compare cannot prove that another same-revision request did not commit.
    // Retain the coalesced marker until an acknowledged advancing mutation fences it.
    throw error;
  });
}
function schedulePushRetry(binding: PushBinding, revision: number, language: "ru" | "en") {
  const state = binding.state;
  if (!binding.session.isCurrent() || state.revision !== revision || state.language !== language || state.retries >= 2
    || document.visibilityState !== "visible" || !navigator.onLine) return;
  const delay = [5000, 15000][state.retries++];
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => { void reconcilePush(binding, language, true); }, delay);
}
function reconcilePush(binding: PushBinding, language: "ru" | "en", retry = false): Promise<void> {
  const { state, session } = binding;
  if (!session.isCurrent()) return Promise.resolve();
  state.language = language;
  reloadPushIntent(state);
  if (state.pending?.epoch === session.epoch && state.pending.language === language && state.pending.revision === state.revision) return state.pending.promise;
  if (!retry) { state.retries = 0; clearTimeout(state.retryTimer); }
  const revision = state.revision;
  let stage: BrowserPushFailure["stage"] = "session";
  state.preparing += 1; publishPush(state);
  const promise = queuePush(async () => {
    reloadPushIntent(state);
    assertPushBinding(binding, revision);
    if (state.intent === false && !state.pendingEnable) {
      // Opt-out recovery must not depend on a usable ServiceWorker/PushManager.
      stage = "configuration";
      const config = await pushCommand<PushConfig>(binding, revision, "web_push_config", { endpoint: null });
      reloadPushIntent(state); assertPushBinding(binding, revision);
      if (config.enabled || config.intentEnabled || controlFences(state).length > 0) {
        await pushCommand(binding, revision, "web_push_unsubscribe", { endpoint: null, intentRevision: config.intentRevision ?? "0" });
        reloadPushIntent(state); assertPushBinding(binding, revision);
      }
      state.publicKey = config.publicKey; state.enabled = false;
      // Confirm server opt-out before browser readiness work. Failure below
      // affects availability only; it cannot prevent the completed CAS fence.
      if (state.error !== NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE) state.error = false;
      publishPush(state);
      stage = "worker";
      const lease = await pushStage(binding, revision, () => notificationWorkerLease());
      reloadPushIntent(state); assertPushBinding(binding, revision);
      assertWorkerLease(lease, state);
      state.registration = lease.registration; state.workerLease = lease;
      state.failure = undefined; state.retries = 0; publishPush(state);
      return;
    }
    stage = "worker";
    const lease = await pushStage(binding, revision, () => notificationWorkerLease());
    const registration = lease.registration;
    // Permission alone says nothing about an existing native subscription.
    // Query workspace intent first only when no local decision requires recovery.
    const mayDeferNativeRead = () => browserNotificationPermission() !== "granted"
      && state.intent !== true && !state.pendingEnable && controlFences(state).length === 0;
    if (mayDeferNativeRead()) {
      stage = "configuration";
      const initialConfig = await pushCommand<PushConfig>(binding, revision, "web_push_config", { endpoint: null });
      reloadPushIntent(state); assertPushBinding(binding, revision);
      assertWorkerLease(lease, state);
      if (mayDeferNativeRead() && initialConfig.intentEnabled === false && initialConfig.enabled === false) {
        stage = "storage";
        if (!rememberNotificationRoute(initialConfig.routingHint, webSession.getIdentifier())) throw new Error("WEB_NOTIFICATION_ROUTE_UNAVAILABLE");
        rememberNotificationClientRoute(session, initialConfig.routingHint, registration);
        state.registration = registration; state.workerLease = lease; state.publicKey = initialConfig.publicKey;
        // Preserve an authoritative opt-out tombstone; never create consent.
        if ((initialConfig.intentRevision ?? "0") !== "0") rememberPushIntent(state, false);
        state.enabled = false; state.error = false; state.failure = undefined; state.retries = 0; publishPush(state);
        return;
      }
    }
    stage = "subscription";
    const subscription = await browserPushStage(binding, revision, lease, () => registration.pushManager?.getSubscription() ?? Promise.resolve(null));
    assertPushBinding(binding, revision);
    let serialized: PushSubscriptionJSON | null = null;
    if (subscription) {
      try { serialized = serializePushSubscription(subscription); } catch (error) {
        if (!nativePushSubscriptionUnavailable(error)) throw error;
        // Keep the public configuration and manual retry available without
        // treating the malformed browser object as a server endpoint.
        state.error = NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE;
      }
    }
    stage = "configuration";
    const config = await pushCommand<PushConfig>(binding, revision, "web_push_config", { endpoint: serialized?.endpoint });
    assertPushBinding(binding, revision);
    reloadPushIntent(state);
    assertPushBinding(binding, revision);
    stage = "storage";
    if (!rememberNotificationRoute(config.routingHint, webSession.getIdentifier())) throw new Error("WEB_NOTIFICATION_ROUTE_UNAVAILABLE");
    rememberNotificationClientRoute(session, config.routingHint, registration);
    state.registration = registration; state.workerLease = lease; state.publicKey = config.publicKey;
    if (state.pendingEnable) {
      // Another tab may be awaiting its explicit enable. Its prior confirmed
      // false is NOT an opt-out, and the old server tombstone cannot cancel it.
      // An abandoned pending decision stays inert until a new user action.
      state.enabled = config.enabled; state.error = false; state.failure = undefined; publishPush(state);
      return;
    }
    // A durable server opt-out defeats stale local true, including a tab that
    // never processed the other tab's storage event. Only a new user enable
    // may override this tombstone using a freshly fetched revision.
    if (config.intentEnabled === false && (config.intentRevision ?? "0") !== "0") rememberPushIntent(state, false);
    // Restore consent from the authenticated workspace. Browser-wide permission
    // alone is insufficient, and an explicit opt-out wins over a server binding.
    if (state.intent === undefined && (config.enabled || config.intentEnabled)) rememberPushIntent(state, true);
    state.enabled = state.intent === false ? false : config.enabled;
    publishPush(state);
    if (state.intent === false) {
      stage = "registration";
      if (config.enabled || config.intentEnabled || controlFences(state).length > 0) {
        await pushCommand(binding, revision, "web_push_unsubscribe", { endpoint: null, intentRevision: config.intentRevision ?? "0" });
        assertPushBinding(binding, revision);
      }
    } else if (state.intent === true && browserNotificationPermission() === "granted" && registration.pushManager && config.publicKey
      && (serialized || state.error !== NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE)) {
      stage = "subscription";
      reloadPushIntent(state);
      assertPushBinding(binding, revision);
      const usable = config.endpointRejected && subscription
        ? await removeRejectedBrowserSubscription(binding, revision, lease, subscription.endpoint)
        : subscription;
      const current = usable ?? await browserPushStage(binding, revision, lease, () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(config.publicKey) }));
      assertPushBinding(binding, revision);
      reloadPushIntent(state);
      assertPushBinding(binding, revision);
      assertWorkerLease(lease, state);
      stage = "registration";
      await pushCommand(binding, revision, "web_push_subscribe", { subscription: serializePushSubscription(current), language, intentRevision: config.intentRevision ?? "0" });
      reloadPushIntent(state);
      assertPushBinding(binding, revision);
      state.enabled = true; state.enableFailure = undefined;
      window.dispatchEvent(new Event(PUSH_VIEW_REFRESH_EVENT));
    }
    reloadPushIntent(state);
    assertPushBinding(binding, revision);
    if (serialized || state.enabled || state.error !== NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE) state.error = false;
    if (!state.error) state.failure = undefined;
    state.retries = 0; publishPush(state);
  }).catch(async (error: unknown) => {
    if (pushIntentChanged(error)) {
      if (await refreshPushConflict(binding, revision)) return;
    }
    reloadPushIntent(state);
    if (session.isCurrent() && state.revision === revision) {
      const nativeUnavailable = nativePushSubscriptionUnavailable(error) || state.error === NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE;
      if (nativeUnavailable) state.enabled = false;
      state.error = nativeUnavailable ? NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE : true;
      state.failure = pushFailure(stage, error);
      publishPush(state);
      // Bounded foreground recovery only; closed-page delivery belongs to the
      // server. Never restore password authorization from this path.
      if (!nativeUnavailable) schedulePushRetry(binding, revision, language);
    }
    // Observers render the error. Avoid unhandled rejections from event handlers.
    void error;
  }).finally(() => {
    if (state.pending?.promise === promise) state.pending = undefined;
    state.preparing -= 1; publishPush(state);
  });
  state.pending = { epoch: session.epoch, language, revision, promise };
  return promise;
}

export function watchBrowserPush(language: "ru" | "en", update: (value: BrowserPushView) => void) {
  let alive = true;
  let binding: PushBinding | undefined;
  let observedEpoch = "";
  const emit = () => {
    if (!alive || !binding?.session.isCurrent()) return;
    const state = binding.state;
    update({ registration: state.registration, publicKey: state.publicKey, enabled: state.enabled, busy: state.busy > 0 || state.preparing > 0, controlBusy: state.busy > 0, consentPending: state.pendingEnable && state.consentRevision === state.revision, error: state.error, optedIn: state.intent === true, binding, failure: state.failure, enableFailure: state.enableFailure?.epoch === binding.session.epoch && state.enableFailure.revision === state.revision ? state.enableFailure.status : undefined, retry: () => refresh(true) });
  };
  const refresh = (force = false) => {
    const session = webSession.captureNotificationSession();
    if (!session) return;
    if (!force && session.epoch === observedEpoch) return; // Heartbeats are not new sessions.
    observedEpoch = session.epoch;
    void session.namespace.then((namespace) => {
      if (!alive || !session.isCurrent() || observedEpoch !== session.epoch) return;
      binding?.state.listeners.delete(emit);
      binding = { session, state: pushState(namespace) };
      binding.state.listeners.add(emit);
      emit();
      void reconcilePush(binding, language);
    }).catch((error: unknown) => { if (alive && session.isCurrent()) update({ registration: null, publicKey: "", enabled: false, busy: false, error: true, failure: pushFailure("session", error), retry: () => refresh(true) }); });
  };
  const resume = () => { if (document.visibilityState === "visible") refresh(true); };
  const online = () => refresh(true);
  const changed = (event: MessageEvent) => {
    if (event.source === navigator.serviceWorker?.controller && event.data?.type === "kaigen-push-subscription-changed") refresh(true);
  };
  const storageChanged = (event: StorageEvent) => {
    if (!binding || event.storageArea !== localStorage
      || event.key !== "kaigen-notification-intent-v1:" + binding.state.namespace) return;
    const state = binding.state;
    const revision = state.revision;
    reloadPushIntent(state);
    if (revision === state.revision) return;
    clearTimeout(state.retryTimer);
    // Already-sent requests are fenced by the server intentRevision. A live
    // tab also repairs its control state after a newer cross-tab decision.
    refresh(true);
  };
  const stopWorkspace = webSession.onWorkspace(() => refresh());
  const stopSession = webSession.onSessionUnavailable(() => {
    observedEpoch = "";
    if (binding) { binding.state.listeners.delete(emit); clearTimeout(binding.state.retryTimer); }
    binding = undefined;
    if (alive) update({ registration: null, publicKey: "", enabled: false, busy: false, error: false });
  });
  window.addEventListener("storage", storageChanged);
  window.addEventListener("online", online);
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", resume);
  navigator.serviceWorker?.addEventListener("message", changed);
  refresh();
  return () => {
    alive = false; stopWorkspace(); stopSession();
    binding?.state.listeners.delete(emit);
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener("online", online); window.removeEventListener("pageshow", resume);
    document.removeEventListener("visibilitychange", resume);
    navigator.serviceWorker?.removeEventListener("message", changed);
  };
}

export function enableBrowserPush(view: BrowserPushView, language: "ru" | "en"): Promise<void> {
  const binding = view.binding, lease = binding?.state.workerLease;
  if (!binding) return Promise.reject(new Error("WEB_NOTIFICATIONS_UNAVAILABLE"));
  assertPushBinding(binding);
  if (!lease || lease.registration !== view.registration || !view.registration?.pushManager || !view.publicKey) {
    const error = new Error("WEB_NOTIFICATIONS_UNAVAILABLE");
    retainPushEnableFailure(binding, binding.state.revision, error); publishPush(binding.state);
    return Promise.reject(error);
  }
  if (worker !== lease.attempt || !activeRegistration(lease.registration)) {
    retainPushEnableFailure(binding, binding.state.revision, new Error("WEB_NOTIFICATIONS_UNAVAILABLE"));
    publishPush(binding.state);
    invalidateWorker(lease, new Error("WEB_NOTIFICATION_WORKER_INACTIVE"), binding.state);
    if (document.visibilityState === "visible" && navigator.onLine) void reconcilePush(binding, language);
    return Promise.reject(new Error("WEB_NOTIFICATIONS_UNAVAILABLE"));
  }
  let request: Promise<PushSubscription>;
  try {
    // MUST start synchronously in this original click; no await/hash/queue first.
    request = view.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(view.publicKey) });
  } catch (error) {
    retainPushEnableFailure(binding, binding.state.revision, error); publishPush(binding.state);
    if (invalidateWorker(lease, error, binding.state) && document.visibilityState === "visible" && navigator.onLine) void reconcilePush(binding, language);
    return Promise.reject(error);
  }
  const state = binding.state;
  reloadPushIntent(state);
  const revision = beginPushDecision(state);
  clearTimeout(state.retryTimer); state.retries = 0;
  // Keep the native request pending until it settles; a permission snapshot
  // cannot distinguish consent from provider work. Cancel/session loss can retire it.
  state.consentRevision = revision;
  const finishConsent = () => {
    if (state.consentRevision === revision) { state.consentRevision = undefined; publishPush(state); }
  };
  const result = browserPushStage(binding, revision, lease, signal => waitForPushConsent(request, signal), null);
  let stage: BrowserPushFailure["stage"] = "subscription";
  state.busy += 1; state.error = false; state.failure = undefined; publishPush(state);
  // A native permission prompt must not hold the shared server-operation queue.
  return result.then(nativeSubscription => {
    finishConsent();
    return queuePush(async () => {
      reloadPushIntent(state); assertPushBinding(binding, revision);
      assertWorkerLease(lease, state);
      const subscription = serializePushSubscription(nativeSubscription);
      stage = "configuration";
      const config = await pushCommand<PushConfig>(binding, revision, "web_push_config", { endpoint: subscription.endpoint });
      assertPushBinding(binding, revision);
      if (config.endpointRejected) {
        await removeRejectedBrowserSubscription(binding, revision, lease, nativeSubscription.endpoint);
        // WebKit may require a fresh user gesture after asynchronous unsubscribe.
        throw new Error("WEB_PUSH_REENABLE_REQUIRED");
      }
      stage = "storage";
      if (!rememberNotificationRoute(config.routingHint, webSession.getIdentifier())) throw new Error("WEB_NOTIFICATION_ROUTE_UNAVAILABLE");
      rememberNotificationClientRoute(binding.session, config.routingHint, lease.registration);
      assertWorkerLease(lease, state);
      stage = "registration";
      await pushCommand(binding, revision, "web_push_subscribe", { subscription, language, intentRevision: config.intentRevision ?? "0" });
      reloadPushIntent(state); assertPushBinding(binding, revision);
      rememberPushIntent(state, true); state.enabled = true; state.failure = undefined; state.enableFailure = undefined;
      window.dispatchEvent(new Event(PUSH_VIEW_REFRESH_EVENT));
    });
  }).catch(async (error: unknown) => {
    reloadPushIntent(state);
    if (binding.session.isCurrent() && state.revision === revision && state.pendingEnable) {
      state.pendingEnable = false; persistPushDecision(state);
    }
    if (binding.session.isCurrent() && state.revision === revision) {
      if (nativePushSubscriptionUnavailable(error)) state.enabled = false;
      state.error = nativePushSubscriptionUnavailable(error) ? NATIVE_PUSH_SUBSCRIPTION_UNAVAILABLE : true;
      state.failure = pushFailure(stage, error);
      retainPushEnableFailure(binding, revision, error);
      publishPush(state);
    }
    if (pushIntentChanged(error)) await refreshPushConflict(binding, revision);
    reloadPushIntent(state);
    if (binding.session.isCurrent() && state.revision === revision && !state.pendingEnable
      && state.intent === false && controlFences(state).length > 0) {
      // Any unknown control failure may have committed remotely. Fence it using
      // ordinary bounded opt-out recovery, never another permission prompt.
      schedulePushRetry(binding, revision, state.language);
    } else if (invalidWorker(lease, error) && binding.session.isCurrent() && document.visibilityState === "visible" && navigator.onLine) void reconcilePush(binding, language);
    throw error;
  }).finally(() => { finishConsent(); state.busy -= 1; publishPush(state); });
}

export function cancelBrowserPushEnable(view: BrowserPushView): Promise<void> {
  const binding = view.binding;
  if (!binding || !binding.session.isCurrent()) return Promise.resolve();
  const state = binding.state;
  reloadPushIntent(state);
  if (!state.pendingEnable || state.consentRevision !== state.revision) return Promise.resolve();
  // Cancel is an explicit opt-out for this workspace/device. Its revision
  // retires the native wait, and its server fence prevents delayed restoration.
  // The origin-wide subscription may serve another workspace and stays intact.
  return disableBrowserPush(view);
}

export function disableBrowserPush(view: BrowserPushView): Promise<void> {
  const binding = view.binding;
  if (!binding) return Promise.reject(new Error("SESSION_NOT_ACTIVE"));
  assertPushBinding(binding);
  const state = binding.state;
  reloadPushIntent(state);
  const revision = beginPushDecision(state, false);
  // Persist opt-out BEFORE any await. An already-sent subscribe cannot be
  // cancelled: queue the final unsubscribe after it instead.
  state.enabled = false;
  clearTimeout(state.retryTimer); state.retries = 0;
  state.busy += 1; state.error = false; publishPush(state);
  let stage: BrowserPushFailure["stage"] = "configuration";
  return queuePush(async () => {
    reloadPushIntent(state);
    assertPushBinding(binding, revision);
    // Current server contract clears ALL bindings of this workspace/device; no browser endpoint read is needed.
    const config = await pushCommand<PushConfig>(binding, revision, "web_push_config", { endpoint: null });
    stage = "registration";
    await pushCommand(binding, revision, "web_push_unsubscribe", { endpoint: null, intentRevision: config.intentRevision ?? "0" });
    assertPushBinding(binding, revision);
    state.failure = undefined;
    // Do not unsubscribe the origin-wide browser endpoint: another workspace
    // may still use it. Only this authenticated workspace/device is unbound.
  }).catch(async (error: unknown) => {
    if (pushIntentChanged(error) && await refreshPushConflict(binding, revision)) return;
    if (binding.session.isCurrent() && state.revision === revision) { state.error = true; state.failure = pushFailure(stage, error); schedulePushRetry(binding, revision, state.language); }
    throw error;
  }).finally(() => { state.busy -= 1; publishPush(state); });
}
