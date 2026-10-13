/* Notification worker only. Never cache API responses, links or profile data. */
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
      data: { routingHint: typeof options.routingHint === "string" ? options.routingHint : "" },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const routingHint = event.notification.data?.routingHint;
    for (const client of windows.slice(0, 8)) {
      const matched = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 500);
        channel.port1.onmessage = (reply) => { clearTimeout(timer); channel.port1.close(); resolve(reply.data?.matched === true); };
        client.postMessage({ type: "kaigen-notification-query", routingHint }, [channel.port2]);
      });
      if (matched) { await client.focus(); client.postMessage({ type: "kaigen-notification-open", routingHint }); return; }
    }
    await self.clients.openWindow("/");
  })());
});
