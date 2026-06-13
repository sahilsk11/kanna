import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir } from "../shared/branding"

export interface CursorApiKeySnapshot {
  apiKey: string
  source: "env" | "file" | "none"
  enabled: boolean
  warning: string | null
  filePathDisplay: string
}

export function getCursorApiKeyFilePath(homeDir = homedir()) {
  return path.join(getDataDir(homeDir), "cursor-api-key.json")
}

function formatDisplayPath(filePath: string) {
  const homePath = homedir()
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}

function normalizeApiKey(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function resolveCursorApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CURSOR_API_KEY?.trim()
  if (fromEnv) return fromEnv
  return ""
}

export async function readCursorApiKeySnapshot(
  filePath = getCursorApiKeyFilePath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CursorApiKeySnapshot> {
  const envKey = env.CURSOR_API_KEY?.trim() ?? ""
  if (envKey) {
    return {
      apiKey: envKey,
      source: "env",
      enabled: true,
      warning: null,
      filePathDisplay: "CURSOR_API_KEY",
    }
  }

  try {
    const text = await readFile(filePath, "utf8")
    const parsed = text.trim() ? JSON.parse(text) as { apiKey?: unknown } : null
    const apiKey = normalizeApiKey(parsed?.apiKey)
    return {
      apiKey,
      source: apiKey ? "file" : "none",
      enabled: apiKey.length > 0,
      warning: apiKey ? null : "Cursor API key is not configured.",
      filePathDisplay: formatDisplayPath(filePath),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        apiKey: "",
        source: "none",
        enabled: false,
        warning: "Cursor API key is not configured.",
        filePathDisplay: formatDisplayPath(filePath),
      }
    }
    if (error instanceof SyntaxError) {
      return {
        apiKey: "",
        source: "none",
        enabled: false,
        warning: "Cursor API key file is invalid JSON.",
        filePathDisplay: formatDisplayPath(filePath),
      }
    }
    throw error
  }
}

export async function writeCursorApiKeySnapshot(
  value: Pick<CursorApiKeySnapshot, "apiKey">,
  filePath = getCursorApiKeyFilePath(),
): Promise<CursorApiKeySnapshot> {
  if (process.env.CURSOR_API_KEY?.trim()) {
    return readCursorApiKeySnapshot(filePath)
  }

  const normalized = normalizeApiKey(value.apiKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify({ apiKey: normalized }, null, 2)}\n`, "utf8")
  return readCursorApiKeySnapshot(filePath)
}

export async function resolveCursorApiKeyForAgent(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const envKey = resolveCursorApiKey(env)
  if (envKey) return envKey
  const snapshot = await readCursorApiKeySnapshot(getCursorApiKeyFilePath(), env)
  return snapshot.apiKey
}
