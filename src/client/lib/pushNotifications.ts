export type PushNotificationStatus =
  | "unsupported"
  | "default"
  | "denied"
  | "enabled"
  | "disabled"

interface PushConfigResponse {
  publicKey: string
}

export function isPushNotificationSupported(win: Window = window) {
  return "serviceWorker" in navigator
    && "PushManager" in win
    && "Notification" in win
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/")
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index)
  }
  return output
}

export async function getPushNotificationStatus(): Promise<PushNotificationStatus> {
  if (!isPushNotificationSupported()) return "unsupported"
  if (Notification.permission === "denied") return "denied"
  if (Notification.permission === "default") return "default"

  const registration = await navigator.serviceWorker.getRegistration("/kanna-push-sw.js")
  const subscription = await registration?.pushManager.getSubscription()
  return subscription ? "enabled" : "disabled"
}

export async function enablePushNotifications() {
  if (!isPushNotificationSupported()) {
    throw new Error("Push notifications are not supported in this browser.")
  }

  const permission = await Notification.requestPermission()
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.")
  }

  const [registration, configResponse] = await Promise.all([
    navigator.serviceWorker.register("/kanna-push-sw.js"),
    fetch("/api/push/config", { headers: { Accept: "application/json" } }),
  ])

  if (!configResponse.ok) {
    throw new Error(`Push configuration failed with status ${configResponse.status}.`)
  }

  const config = await configResponse.json() as PushConfigResponse
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  })

  const subscribeResponse = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })

  if (!subscribeResponse.ok) {
    await subscription.unsubscribe().catch(() => false)
    throw new Error(`Push subscription failed with status ${subscribeResponse.status}.`)
  }
}

export async function disablePushNotifications() {
  const registration = await navigator.serviceWorker.getRegistration("/kanna-push-sw.js")
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return

  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined)

  await subscription.unsubscribe()
}

