self.addEventListener("push", (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = typeof payload.title === "string" ? payload.title : "Kanna"
  const body = typeof payload.body === "string" ? payload.body : ""
  const url = typeof payload.url === "string" ? payload.url : "/"
  const tag = typeof payload.tag === "string" ? payload.tag : "kanna-chat"

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: "window", includeUncontrolled: true })
    if (windowClients.some((client) => client.focused)) {
      return
    }

    await self.registration.showNotification(title, {
      body,
      tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    })
  })())
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = event.notification.data?.url || "/"
  const targetUrl = new URL(url, self.location.origin).href

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: "window", includeUncontrolled: true })
    for (const client of windowClients) {
      if ("focus" in client) {
        await client.focus()
        if ("navigate" in client) {
          await client.navigate(targetUrl)
        }
        return
      }
    }

    await clients.openWindow(targetUrl)
  })())
})
