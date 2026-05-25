import { describe, expect, test } from "bun:test"
import { getDefaultProjectPath } from "./paths"

describe("paths", () => {
  test("reads the default project path from KANNA_DEFAULT_PROJECT_PATH", () => {
    const previousValue = process.env.KANNA_DEFAULT_PROJECT_PATH
    process.env.KANNA_DEFAULT_PROJECT_PATH = "/tmp/kanna-projects"

    try {
      expect(getDefaultProjectPath()).toBe("/tmp/kanna-projects")
    } finally {
      if (previousValue === undefined) {
        delete process.env.KANNA_DEFAULT_PROJECT_PATH
      } else {
        process.env.KANNA_DEFAULT_PROJECT_PATH = previousValue
      }
    }
  })
})
