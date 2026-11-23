/* Notification worker only. Never cache API responses, links or profile data.
 * The bounded client directory contains only opaque routing/URL digests. It
 * selects a window; only that authenticated page may resolve an event target. */
const CLIENT_ROUTE_CACHE = "kaigen-notification-clients-v1";
const CLIENT_ROUTE_KEY = new URL("/.kaigen-notification-clients-v1", self.location.origin).href;
const CLIENT_ROUTE_TTL = 24 * 60 * 60 * 1000;
let clientRouteQueue = Promise.resolve();
let clientRouteMutation = 0;
const routingHintValid = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
async function clientUrlDigest(client) {
  if (new URL(client.url).origin !== self.location.origin) throw new Error("FOREIGN_CLIENT");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client.url));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function serializeClientRoutes(operation) {
  const result = clientRouteQueue.then(operation, operation);
  clientRouteQueue = result.catch(() => {});
  return result;
}
async function readClientRoutes() {
  const cache = await caches.open(CLIENT_ROUTE_CACHE);
  const response = await cache.match(CLIENT_ROUTE_KEY);
  const value = response ? await response.json() : [];
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  return value.filter(row => row && typeof row.clientId === "string" && row.clientId.length <= 128
    && /^[a-f0-9]{64}$/.test(row.urlDigest) && Number.isSafeInteger(row.revision) && row.revision > 0
    && (row.routingHint === null || routingHintValid(row.routingHint)) && typeof row.standalone === "boolean"
    && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now && row.expiresAt <= now + CLIENT_ROUTE_TTL).slice(0, 32);
}
async function updateClientRoute(event) {
  const message = event.data;
  if (!event.source || event.source.type !== "window" || !Number.isSafeInteger(message.revision) || message.revision <= 0) return;
  const client = await self.clients.get(event.source.id);
  if (!client || client.type !== "window" || client.frameType === "nested") return;
  const urlDigest = await clientUrlDigest(client);
  const rows = await readClientRoutes();
  const previous = rows.find(row => row.clientId === client.id);
  if (previous && previous.revision >= message.revision) return;
  const retired = message.type === "kaigen-notification-client-retire";
  if (!retired && (!routingHintValid(message.routingHint) || typeof message.standalone !== "boolean")) return;
  // A page may bind before this worker controls it. Keep those live routes too.
  const live = new Set((await self.clients.matchAll({ type: "window", includeUncontrolled: true })).map(window => window.id));
  const next = rows.filter(row => row.clientId !== client.id && live.has(row.clientId));
  // Keep retirement tombstones too: a delayed older bind cannot resurrect one.
  next.unshift({ clientId: client.id, urlDigest, revision: message.revision,
    routingHint: retired ? null : message.routingHint, standalone: !retired && message.standalone,
    expiresAt: Date.now() + CLIENT_ROUTE_TTL });
  const cache = await caches.open(CLIENT_ROUTE_CACHE);
  await cache.put(CLIENT_ROUTE_KEY, new Response(JSON.stringify(next.slice(0, 32)), { headers: { "Content-Type": "application/json" } }));
}
self.addEventListener("message", (event) => {
  if (!event.data || !["kaigen-notification-client-bind", "kaigen-notification-client-retire"].includes(event.data.type)) return;
  clientRouteMutation += 1;
  event.waitUntil(serializeClientRoutes(() => updateClientRoute(event)).catch(() => {}));
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let options = {};
    try { const parsed = event.data?.json(); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) options = parsed; } catch { /* Generic fallback is always visible. */ }
    const ru = options.language !== "en";
    // Every push must create a visible notification, including in the foreground.
    await self.registration.showNotification("Kaigen", {
      body: ru ? "В подключённом профиле новые события" : "New events in a connected profile",
      icon: "/kaigen-icon.png", badge: "/kaigen-icon.png", tag: `kaigen-events-${options.routingHint || "generic"}`,
      silent: options.silent !== false,
      renotify: options.silent === false,
      data: {
        routingHint: typeof options.routingHint === "string" ? options.routingHint : "",
        eventToken: typeof options.eventToken === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(options.eventToken)
          ? options.eventToken : null,
      },
    });
  })());
});
function matchesNotification(client, routingHint, eventToken) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (matched) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(matched);
    };
    // An explicit live rejection must never become a cached-route fallback.
    const timer = setTimeout(() => finish(null), 500);
    channel.port1.onmessage = (reply) => finish(reply.data?.matched === true);
    try {
      client.postMessage({ type: "kaigen-notification-query", routingHint, eventToken }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish(null);
    }
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const routingHint = event.notification.data?.routingHint;
    const eventToken = event.notification.data?.eventToken;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true }).catch(() => []);
    const rows = await serializeClientRoutes(readClientRoutes).catch(() => []);
    const preferred = rows.filter(row => row.routingHint === routingHint && row.standalone).map(row => row.clientId);
    windows.sort((left, right) => Number(preferred.includes(right.id)) - Number(preferred.includes(left.id)));
    const replies = await Promise.all(windows.slice(0, 32).map(async client =>
      ({ client, matched: await matchesNotification(client, routingHint, eventToken) })));
    // Drain binds/retirements received DURING the queries before choosing. Never
    // hold their queue while waiting for a frozen page to answer.
    const selection = await serializeClientRoutes(async () => {
      const revision = clientRouteMutation; // Capture BEFORE the asynchronous storage read.
      return { revision, rows: await readClientRoutes() };
    }).catch(() => ({ revision: clientRouteMutation, rows: [] }));
    const currentRows = selection.rows, selectionRevision = selection.revision;
    const candidates = await Promise.all(replies.map(async ({ client, matched }) => {
      if (matched === false) return null;
      const row = currentRows.find(value => value.clientId === client.id && value.routingHint === routingHint);
      const attested = row && await clientUrlDigest(client).then(digest => digest === row.urlDigest, () => false);
      if (matched !== true && !attested) return null;
      return { client, standalone: !!attested && row.standalone };
    }));
    candidates.sort((left, right) => Number(!!right?.standalone) - Number(!!left?.standalone));
    for (const candidate of candidates) {
      if (clientRouteMutation !== selectionRevision) break; // A bind/retirement arrived during digest validation.
      if (!candidate) continue;
      const { client } = candidate;
      try {
        let focused = await client.focus();
        const firefox = /Firefox\//.test(self.navigator?.userAgent ?? "");
        // Firefox resolves focus before its window transition completes. Refresh the
        // live client briefly before falling back, or openWindow steals that focus.
        if (firefox && focused && focused.visibilityState !== "visible") {
          const visibilityDeadline = Date.now() + 500;
          do {
            await new Promise(resolve => setTimeout(resolve, 50));
            focused = await self.clients.get(client.id);
          } while (focused && focused.visibilityState !== "visible" && Date.now() < visibilityDeadline);
        }
        // Chromium focus consumes window interaction; keep its existing OPEN path.
        if (!focused || (firefox && focused.visibilityState !== "visible")) continue;
        focused.postMessage({ type: "kaigen-notification-open", routingHint, eventToken });
        return;
      } catch { /* This window disappeared; try the next match or launch. */ }
    }
    // No live or attested matching client remains. The installation hint and
    // sealed event token contain no readable profile or contact identifiers.
    const hint = typeof routingHint === "string" && /^[A-Za-z0-9_-]{22}$/.test(routingHint)
      ? routingHint : "invalid";
    const params = new URLSearchParams({ "kaigen-notification": hint });
    if (typeof eventToken === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(eventToken)) {
      params.set("kaigen-notification-event", eventToken);
    }
    await self.clients.openWindow("/?" + params.toString());
  })());
});

// No authentication secrets or renewal capability live in this worker. A live
// authenticated page can repair its own binding; a closed page waits for return.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: "kaigen-push-subscription-changed" });
  })());
});
