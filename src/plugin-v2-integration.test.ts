import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

vi.mock("@opencode-ai/plugin", () => ({
  tool: Object.assign(
    (definition: unknown) => definition,
    {
      schema: {
        string: () => ({ describe: () => ({}) }),
        boolean: () => ({ optional: () => ({ default: () => ({ describe: () => ({}) }) }) }),
        array: () => ({ optional: () => ({ describe: () => ({}) }) }),
      },
    },
  ),
}))

import { createAntigravityPlugin } from "./plugin.ts"
import { AccountManager } from "./plugin/accounts.ts"
import type { LoaderResult, PluginClient, PluginContext } from "./plugin/types.ts"

const testDirectories: string[] = []
const plugins: Array<{ dispose?: () => void }> = []
const accountManagers: AccountManager[] = []
let priorConfigDirectory: string | undefined

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "antigravity-v2-driver-"))
  testDirectories.push(directory)
  if (priorConfigDirectory === undefined) priorConfigDirectory = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = directory
  mkdirSync(join(directory, ".opencode"))
  writeFileSync(join(directory, ".opencode", "antigravity.json"), JSON.stringify({
    auto_update: false,
    proactive_token_refresh: false,
  }))
  return directory
}

function trackPlugin<T extends { dispose?: () => void }>(plugin: T): T {
  plugins.push(plugin)
  return plugin
}

function createClient(): PluginClient {
  return {
    app: { log: async () => undefined },
    tui: { showToast: async () => undefined },
    auth: { set: async () => undefined },
    session: {
      prompt: async () => undefined,
      abort: async () => undefined,
      messages: async () => ({ data: [] }),
    },
  } as unknown as PluginClient
}

function isLoader(value: LoaderResult | Record<string, unknown>): value is LoaderResult {
  return "fetch" in value && typeof value.fetch === "function"
}

function driverFetch(loader: LoaderResult): typeof globalThis.fetch {
  return async (input, init) => {
    if (input instanceof URL) return loader.fetch(input.toString(), init)
    return loader.fetch(input, init)
  }
}

function generateOptions(thinkingLevel: "low" | "medium" | "high"): LanguageModelV3CallOptions {
  return {
    prompt: [{
      role: "user",
      content: [{ type: "text", text: "Describe the transport route." }],
    }],
    providerOptions: {
      google: { thinkingConfig: { thinkingLevel, includeThoughts: true } },
    },
  }
}

function googleResponse(): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { role: "model", parts: [{ text: "transport response" }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  }), { headers: { "content-type": "application/json" } })
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input)
}

beforeEach(() => {
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_ANTIGRAVITY_API_KEYS"]) {
    vi.stubEnv(name, "")
  }
  const loadFromDisk = AccountManager.loadFromDisk
  vi.spyOn(AccountManager, "loadFromDisk").mockImplementation(async (auth) => {
    const manager = await loadFromDisk(auth)
    accountManagers.push(manager)
    return manager
  })
})

afterEach(async () => {
  for (const plugin of plugins.splice(0)) plugin.dispose?.()
  for (const manager of accountManagers.splice(0)) await manager.flushSaveToDisk()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  if (priorConfigDirectory === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = priorConfigDirectory
  }
  priorConfigDirectory = undefined
})

describe("Antigravity transport through @ai-sdk/google", () => {
  it("reports the failed refresh token to V2 instead of clearing the current host credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    const directory = createDirectory()
    const client = createClient()
    client.auth.revoke = vi.fn(async () => undefined)
    const set = vi.spyOn(client.auth, "set")
    const plugin = trackPlugin(await createAntigravityPlugin("google")({ client, directory, runtime: "v2" }))
    const loaded = await plugin.auth.loader(async () => ({
      type: "oauth",
      refresh: "revoked-token|test-project|managed-project",
      access: "expired-access",
      expires: 1,
    }), { id: "google" })
    if (!isLoader(loaded)) throw new Error("OAuth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-3-pro-preview")

    await expect(model.doGenerate(generateOptions("high"))).rejects.toThrow()
    expect(client.auth.revoke).toHaveBeenCalledWith("revoked-token")
    expect(set).not.toHaveBeenCalled()
  })

  it("rewrites an OAuth Gemini request, retains the variant thinking level, and parses the Google driver response", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      requests.push({ url, init })
      return googleResponse()
    }))
    const directory = createDirectory()
    const context: PluginContext = {
      client: createClient(),
      directory,
      runtime: "v2",
    }
    const plugin = trackPlugin(await createAntigravityPlugin("google")(context))
    const loaded = await plugin.auth.loader(
      async () => ({
        type: "oauth",
        refresh: "refresh-token|test-project|managed-project",
        access: "oauth-access",
        expires: Date.now() + 3_600_000,
      }),
      { id: "google" },
    )
    if (!isLoader(loaded)) throw new Error("OAuth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-3-pro-preview")

    const result = await model.doGenerate(generateOptions("high"))

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    const transport = requests.find((request) => request.url.includes("v1internal:generateContent"))
    expect(transport?.url).toContain("cloudcode-pa")
    const body = JSON.parse(String(transport?.init?.body)) as {
      request?: {
        generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } }
      }
    }
    expect(body.request?.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true })
  })

  it("routes API-key credentials through the real driver while replacing its placeholder key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      requests.push({ url, init })
      return googleResponse()
    }))
    const directory = createDirectory()
    const plugin = trackPlugin(await createAntigravityPlugin("google")({
      client: createClient(),
      directory,
      runtime: "v2",
    }))
    const loaded = await plugin.auth.loader(
      async () => ({ type: "api", key: "plugin-api-key" }),
      { id: "google" },
    )
    if (!isLoader(loaded)) throw new Error("API-key auth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-2.5-flash")

    const result = await model.doGenerate(generateOptions("medium"))

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain("generativelanguage.googleapis.com")
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get("x-goog-api-key")).toBe("plugin-api-key")
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } }
    }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "medium", includeThoughts: true })
  })

  it("prefers an active V2 OAuth credential over the stored active account", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      requests.push({ url, init })
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      }
      return googleResponse()
    }))
    const directory = createDirectory()
    writeFileSync(join(directory, "antigravity-accounts.json"), JSON.stringify({
      version: 4,
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
      accounts: [
        {
          email: "stored-a@example.test",
          refreshToken: "stored-refresh-a",
          projectId: "stored-project-a",
          managedProjectId: "stored-managed-a",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          email: "oauth-b@example.test",
          refreshToken: "oauth-refresh-b",
          projectId: "oauth-project-b",
          managedProjectId: "oauth-managed-b",
          addedAt: 2,
          lastUsed: 0,
        },
      ],
    }, null, 2))
    const plugin = trackPlugin(await createAntigravityPlugin("google")({
      client: createClient(),
      directory,
      runtime: "v2",
    }))
    const loaded = await plugin.auth.loader(
      async () => ({
        type: "oauth",
        refresh: "oauth-refresh-b|oauth-project-b|oauth-managed-b",
        access: "oauth-access-b",
        expires: Date.now() + 3_600_000,
      }),
      { id: "google" },
    )
    if (!isLoader(loaded)) throw new Error("OAuth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-3-pro-preview")

    const result = await model.doGenerate(generateOptions("high"))

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    const transport = requests.find((request) => request.url.includes("v1internal:generateContent"))
    expect(new Headers(transport?.init?.headers).get("authorization")).toBe("Bearer oauth-access-b")
    expect(requests.some((request) => String(request.init?.body).includes("stored-refresh-a"))).toBe(false)
  })
})
