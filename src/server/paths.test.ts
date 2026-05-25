import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"
import { getDefaultProjectPath } from "./paths"

describe("paths", () => {
  function withDefaultProjectPath(value: string | undefined, assertion: () => void) {
    const previousValue = process.env.KANNA_DEFAULT_PROJECT_PATH
    if (value === undefined) {
      delete process.env.KANNA_DEFAULT_PROJECT_PATH
    } else {
      process.env.KANNA_DEFAULT_PROJECT_PATH = value
    }

    try {
      assertion()
    } finally {
      if (previousValue === undefined) {
        delete process.env.KANNA_DEFAULT_PROJECT_PATH
      } else {
        process.env.KANNA_DEFAULT_PROJECT_PATH = previousValue
      }
    }
  }

  test("reads the default project path from KANNA_DEFAULT_PROJECT_PATH", () => {
    withDefaultProjectPath("/tmp/kanna-projects", () => {
      expect(getDefaultProjectPath()).toBe("/tmp/kanna-projects")
    })
  })

  test("falls back when KANNA_DEFAULT_PROJECT_PATH is empty", () => {
    withDefaultProjectPath("", () => {
      expect(getDefaultProjectPath()).toBe(path.join(homedir(), "projects"))
    })
  })

  test("falls back when KANNA_DEFAULT_PROJECT_PATH is whitespace", () => {
    withDefaultProjectPath("   ", () => {
      expect(getDefaultProjectPath()).toBe(path.join(homedir(), "projects"))
    })
  })
})
