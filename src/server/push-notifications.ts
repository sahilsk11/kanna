import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import webpush from "web-push"
import type { PushSubscription } from "web-push"
import type { KannaStatus, SidebarData } from "../shared/types"

interface PushNotificationFile {
  vapid: {
    publicKey: string
    privateKey: string
  }
  subscriptions: StoredPushSubscription[]
}

interface StoredPushSubscription {
  endpoint: string
  subscription: PushSubscription
  createdAt: number
  updatedAt: number
}

interface PushNotificationPayload {
  title: string
  body: string
  url: string
  tag: string
}

const PUSH_FILE_NAME = "push-notifications.json"
const RUNNING_STATUSES = new Set<KannaStatus>(["starting", "running"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isPushSubscription(value: unknown): value is PushSubscription {
  if (!isRecord(value)) return false
  if (typeof value.endpoint !== "string" || value.endpoint.length === 0) return false
  if (!isRecord(value.keys)) return false
  return typeof value.keys.p256dh === "string" && typeof value.keys.auth === "string"
}

function normalizePushFile(value: unknown): PushNotificationFile | null {
  if (!isRecord(value) || !isRecord(value.vapid)) return null
  const publicKey = value.vapid.publicKey
  const privateKey = value.vapid.privateKey
  if (typeof publicKey !== "string" || typeof privateKey !== "string") return null

  const subscriptions = Array.isArray(value.subscriptions)
    ? value.subscriptions
      .filter((entry): entry is StoredPushSubscription => (
        isRecord(entry)
        && typeof entry.endpoint === "string"
        && isPushSubscription(entry.subscription)
        && typeof entry.createdAt === "number"
        && typeof entry.updatedAt === "number"
      ))
    : []

  return {
    vapid: { publicKey, privateKey },
    subscriptions,
  }
}

function createPushFile(): PushNotificationFile {
  const keys = webpush.generateVAPIDKeys()
  return {
    vapid: {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
    subscriptions: [],
  }
}

function flattenSidebarChats(sidebarData: SidebarData) {
  return sidebarData.projectGroups.flatMap((group) => (
    group.chats.map((chat) => ({
      chatId: chat.chatId,
      title: chat.title,
      status: chat.status,
    }))
  ))
}

export class PushNotificationManager {
  private state: PushNotificationFile | null = null
  private previousStatuses = new Map<string, KannaStatus>()
  private readonly filePath: string

  constructor(dataDir: string, private readonly appName: string) {
    this.filePath = path.join(dataDir, PUSH_FILE_NAME)
  }

  async initialize() {
    this.state = await this.readOrCreateState()
    webpush.setVapidDetails(
      "https://kanna.local",
      this.state.vapid.publicKey,
      this.state.vapid.privateKey,
    )
  }

  getPublicKey() {
    if (!this.state) {
      throw new Error("Push notifications are not initialized")
    }
    return this.state.vapid.publicKey
  }

  async handleApiRequest(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/api/push/config") {
      if (req.method !== "GET") {
        return new Response(null, { status: 405, headers: { Allow: "GET" } })
      }
      return Response.json({ publicKey: this.getPublicKey() })
    }

    if (url.pathname === "/api/push/subscribe") {
      if (req.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } })
      }
      const body = await req.json().catch(() => null)
      const subscription = isRecord(body) ? body.subscription : null
      if (!isPushSubscription(subscription)) {
        return Response.json({ error: "Invalid push subscription" }, { status: 400 })
      }
      await this.saveSubscription(subscription)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/api/push/unsubscribe") {
      if (req.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } })
      }
      const body = await req.json().catch(() => null)
      const endpoint = isRecord(body) && typeof body.endpoint === "string" ? body.endpoint : ""
      if (!endpoint) {
        return Response.json({ error: "Missing push endpoint" }, { status: 400 })
      }
      await this.removeSubscription(endpoint)
      return Response.json({ ok: true })
    }

    return null
  }

  async handleSidebarData(sidebarData: SidebarData) {
    const notifications = this.getNotificationsForSidebar(sidebarData)
    if (notifications.length === 0) return

    for (const notification of notifications) {
      await this.send(notification)
    }
  }

  getNotificationsForSidebar(sidebarData: SidebarData): PushNotificationPayload[] {
    const nextStatuses = new Map<string, KannaStatus>()
    const notifications: PushNotificationPayload[] = []

    for (const chat of flattenSidebarChats(sidebarData)) {
      nextStatuses.set(chat.chatId, chat.status)
      const previousStatus = this.previousStatuses.get(chat.chatId)
      if (!previousStatus) continue

      if (chat.status === "waiting_for_user" && RUNNING_STATUSES.has(previousStatus)) {
        notifications.push({
          title: `${this.appName} needs you`,
          body: chat.title,
          url: `/chat/${encodeURIComponent(chat.chatId)}`,
          tag: `kanna-chat-waiting-${chat.chatId}`,
        })
      }
    }

    this.previousStatuses = nextStatuses
    return notifications
  }

  private async readOrCreateState() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"))
      const normalized = normalizePushFile(parsed)
      if (normalized) return normalized
    } catch {
      // Recreate missing or corrupt push state.
    }

    const state = createPushFile()
    await this.writeState(state)
    return state
  }

  private async saveSubscription(subscription: PushSubscription) {
    if (!this.state) return
    const now = Date.now()
    const existing = this.state.subscriptions.find((entry) => entry.endpoint === subscription.endpoint)
    if (existing) {
      existing.subscription = subscription
      existing.updatedAt = now
    } else {
      this.state.subscriptions.push({
        endpoint: subscription.endpoint,
        subscription,
        createdAt: now,
        updatedAt: now,
      })
    }
    await this.writeState(this.state)
  }

  private async removeSubscription(endpoint: string) {
    if (!this.state) return
    const nextSubscriptions = this.state.subscriptions.filter((entry) => entry.endpoint !== endpoint)
    if (nextSubscriptions.length === this.state.subscriptions.length) return
    this.state.subscriptions = nextSubscriptions
    await this.writeState(this.state)
  }

  private async send(payload: PushNotificationPayload) {
    if (!this.state || this.state.subscriptions.length === 0) return
    const serialized = JSON.stringify(payload)
    const staleEndpoints: string[] = []

    await Promise.all(this.state.subscriptions.map(async (entry) => {
      try {
        await webpush.sendNotification(entry.subscription, serialized)
      } catch (error) {
        const statusCode = isRecord(error) && typeof error.statusCode === "number" ? error.statusCode : null
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.push(entry.endpoint)
          return
        }
        console.warn("[push] Failed to send notification:", error)
      }
    }))

    if (staleEndpoints.length > 0) {
      const stale = new Set(staleEndpoints)
      this.state.subscriptions = this.state.subscriptions.filter((entry) => !stale.has(entry.endpoint))
      await this.writeState(this.state)
    }
  }

  private async writeState(state: PushNotificationFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  }
}
