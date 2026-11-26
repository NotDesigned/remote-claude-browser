/*
 * The workbench's service worker, for website notifications only (see
 * src/notifications/controller.ts). Android Chrome shows notifications only through a service
 * worker; this one reports their clicks and closes to the gateway and brings the workbench to the
 * front. It handles no fetches: the workbench loads exactly as without it.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** The notification's session and the gateway's id for it, as the workbench gave them. */
function target(notification) {
  const data = notification.data;
  if (!data || typeof data.sid !== "string" || typeof data.id !== "string") return null;
  return data;
}

function report(data, type) {
  return fetch(`/s/${encodeURIComponent(data.sid)}/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t: "notify-event", id: data.id, type }),
    credentials: "same-origin",
  }).catch(() => undefined);
}

self.addEventListener("notificationclick", (event) => {
  const data = target(event.notification);
  event.notification.close();
  if (data === null) return;
  event.waitUntil(
    (async () => {
      // First the tab, so that the workbench shows it when it comes up.
      await report(data, "click");
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const own = windows.filter((client) => new URL(client.url).origin === self.location.origin);
      const best = own.find((client) => client.focused) ?? own[0];
      if (best) await best.focus().catch(() => undefined);
      else await self.clients.openWindow("/");
    })(),
  );
});

self.addEventListener("notificationclose", (event) => {
  const data = target(event.notification);
  if (data !== null) event.waitUntil(report(data, "close"));
});
