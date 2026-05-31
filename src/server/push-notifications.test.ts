import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PushNotificationManager } from "./push-notifications"
import type { KannaStatus, SidebarData } from "../shared/types"

function sidebar(status: KannaStatus): SidebarData {
  return {
    projectGroups: [{
      groupKey: "project-1",
      title: "Project",
      realTitle: "Project",
      localPath: "/tmp/project",
      chats: [{
        _id: "chat-1",
        _creationTime: 1,
        chatId: "chat-1",
        title: "Build iOS app",
        status,
        unread: false,
        localPath: "/tmp/project",
        provider: "codex",
        hasAutomation: false,
      }],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }],
  }
}

describe("PushNotificationManager", () => {
  test("initializes VAPID state in the data directory", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-push-"))
    const manager = new PushNotificationManager(dataDir, "Kanna")

    await manager.initialize()

    expect(manager.getPublicKey().length).toBeGreaterThan(0)
  })

  test("does not notify on initial sidebar hydration", () => {
    const manager = new PushNotificationManager("/tmp/kanna-test", "Kanna")

    expect(manager.getNotificationsForSidebar(sidebar("running"))).toEqual([])
  })

  test("does not notify when a running session becomes idle", () => {
    const manager = new PushNotificationManager("/tmp/kanna-test", "Kanna")

    manager.getNotificationsForSidebar(sidebar("running"))

    expect(manager.getNotificationsForSidebar(sidebar("idle"))).toEqual([])
  })

  test("notifies when a running session starts waiting for the user", () => {
    const manager = new PushNotificationManager("/tmp/kanna-test", "Kanna")

    manager.getNotificationsForSidebar(sidebar("running"))

    expect(manager.getNotificationsForSidebar(sidebar("waiting_for_user"))).toEqual([{
      title: "Kanna needs you",
      body: "Build iOS app",
      url: "/chat/chat-1",
      tag: "kanna-chat-waiting-chat-1",
    }])
  })

  test("does not notify for repeated waiting or waiting-to-idle transitions", () => {
    const manager = new PushNotificationManager("/tmp/kanna-test", "Kanna")

    manager.getNotificationsForSidebar(sidebar("running"))
    manager.getNotificationsForSidebar(sidebar("waiting_for_user"))

    expect(manager.getNotificationsForSidebar(sidebar("waiting_for_user"))).toEqual([])
    expect(manager.getNotificationsForSidebar(sidebar("idle"))).toEqual([])
  })
})
