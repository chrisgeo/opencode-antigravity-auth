import { afterEach, describe, expect, it, vi } from "vitest"
import { Integration, Model, Provider } from "@opencode/plugin"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type {
  IntegrationEditor,
  IntegrationMethodRegistration,
} from "@opencode/plugin/promise/integration"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { ProviderModel } from "./plugin/types.ts"

const core = vi.hoisted(() => ({
  create: vi.fn(),
  loadConfig: vi.fn(),
}))

vi.mock("./plugin.ts", () => ({
  createAntigravityPlugin: core.create,
}))

vi.mock("./plugin/config/index.ts", () => ({
  loadConfig: core.loadConfig,
}))

const { AntigravityV2Plugin } = await import("./plugin-v2.ts")

type OAuthResult = {
  type: "success"
  refresh: string
  access: string
  expires: number
}

type LegacyLoader = {
  apiKey: string
  fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>
}

type LegacyLoaderResult = LegacyLoader | Record<string, never>

interface LegacyHooks {
  auth: {
    loader: (getAuth: () => Promise<unknown>) => Promise<LegacyLoaderResult>
    methods: Array<{
      type: "oauth" | "api"
      authorize?: (inputs?: Record<string, string>) => Promise<{
        url: string
        instructions: string
        method: "auto" | "code"
        callback: (() => Promise<OAuthResult>) | ((code: string) => Promise<OAuthResult>)
      }>
    }>
  }
  provider: {
    models: () => Promise<Record<string, ProviderModel>>
  }
  tool: Record<string, never>
  event: (input: unknown) => Promise<void>
  dispose: () => void
}

interface RegisteredHooks {
  integration: IntegrationMethodRegistration[]
  aisdk?: (event: AISDKEvent) => Promise<void>
  recovery?: (event: SessionContext) => void
}

interface AISDKEvent {
  options: Record<string, unknown>
  sdk?: unknown
}

interface GoogleDriverModel {
  doGenerate: (options: LanguageModelV3CallOptions) => Promise<{ content: unknown }>
}

type GoogleDriverFactory = (modelID: string) => GoogleDriverModel

interface TestProviderEditor {
  get: (providerID: string) => { models: ReadonlyMap<string, Model.Info> } | undefined
  add: (input: { models: readonly Model.Info[] }) => void
  update: (providerID: string, update: (provider: { package?: string; activation?: string }) => void) => void
  models: {
    set: (providerID: string, models: readonly Model.Info[]) => void
  }
}

interface TestModelEditor {
  list: (providerID: string) => readonly Model.Info[]
  update: (providerID: string, modelID: string, update: (model: { package?: string }) => void) => void
}

interface TestToolEditor {
  add: (input: unknown) => void
}

interface TestContext {
  location: { directory: string }
  integration: {
    transform: (callback: (editor: IntegrationEditor) => void) => Promise<{ dispose: () => Promise<void> }>
    connection: {
      active: () => Promise<unknown>
      resolve: () => Promise<unknown>
      status: (input: unknown) => Promise<void>
    }
  }
  provider: {
    transform: (callback: (editor: TestProviderEditor) => void) => Promise<{ dispose: () => Promise<void> }>
    reload: () => Promise<void>
  }
  model: {
    transform: (callback: (editor: TestModelEditor) => void) => Promise<{ dispose: () => Promise<void> }>
  }
  aisdk: {
    hook: (
      name: "sdk",
      callback: (event: AISDKEvent) => Promise<void>,
      options: { providerID: string },
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  session: {
    hook: (
      name: "context",
      callback: (event: SessionContext) => void,
      options: { providerID: string },
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  tool: {
    transform: (callback: (editor: TestToolEditor) => void) => Promise<{ dispose: () => Promise<void> }>
  }
  event: {
    subscribe: (input: { signal: AbortSignal }) => AsyncIterable<unknown>
  }
}

function registration(): { dispose: () => Promise<void> } {
  return { dispose: async () => undefined }
}

function providerModel(id: string): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make("google"), Model.ID.make(id)),
    name: id,
  }
}

function isGoogleDriverFactory(value: unknown): value is GoogleDriverFactory {
  return typeof value === "function"
}

function googleResponse(): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { role: "model", parts: [{ text: "SDK transport response" }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  }), { headers: { "content-type": "application/json" } })
}

function generateOptions(thinkingLevel: "low" | "medium" | "high"): LanguageModelV3CallOptions {
  return {
    prompt: [{
      role: "user",
      content: [{ type: "text", text: "Check the hooked SDK factory." }],
    }],
    providerOptions: {
      google: { thinkingConfig: { thinkingLevel, includeThoughts: true } },
    },
  }
}

function buildLegacy(options: {
  loader: LegacyLoaderResult
  loaderForAuth?: (getAuth: () => Promise<unknown>) => Promise<LegacyLoaderResult>
  authorization: {
    method: "auto" | "code"
    callback: (() => Promise<OAuthResult>) | ((code: string) => Promise<OAuthResult>)
  }
  definitions?: Record<string, ProviderModel>
}): LegacyHooks {
  return {
    auth: {
      loader: vi.fn(options.loaderForAuth ?? (async () => options.loader)),
      methods: [{
        type: "oauth",
        authorize: vi.fn(async () => ({
          url: "https://accounts.example.test/authorize",
          instructions: "Sign in",
          ...options.authorization,
        })),
      }],
    },
    provider: {
      models: vi.fn(async () => options.definitions ?? {
        "antigravity-gemini": { name: "Gemini (Antigravity)" },
      }),
    },
    tool: {},
    event: vi.fn(async () => undefined),
    dispose: vi.fn(),
  }
}

function createContext(options: {
  credential?: { type: "oauth"; refresh: string; access: string; expires: number } | { type: "key"; key: string }
  existingModels?: Model.Info[]
  events?: AsyncIterable<unknown>
} = {}): { context: TestContext; hooks: RegisteredHooks; providerModels: Model.Info[] } {
  const hooks: RegisteredHooks = { integration: [] }
  const providerModels = [...(options.existingModels ?? [])]

  const integrationEditor: IntegrationEditor = {
    list: () => [],
    get: () => undefined,
    update: () => undefined,
    remove: () => undefined,
    method: {
      list: () => [],
      update: (input) => hooks.integration.push(input),
      remove: () => undefined,
    },
  }
  const providerEditor: TestProviderEditor = {
    get: () => providerModels.length === 0 ? undefined : {
      provider: {
        ...Provider.Info.empty(Provider.ID.make("google")),
        name: "Custom Google",
        package: "custom-package",
      },
      models: new Map(providerModels.map((model) => [model.id, model])),
    },
    add: (input) => { providerModels.splice(0, providerModels.length, ...input.models) },
    update: () => undefined,
    models: {
      set: (_providerID, models) => { providerModels.splice(0, providerModels.length, ...models) },
    },
  }
  const modelEditor: TestModelEditor = {
    list: () => providerModels,
    update: (_providerID, modelID, update) => {
      const model = providerModels.find((candidate) => String(candidate.id) === modelID)
      if (model) update(model)
    },
  }
  const noEvents = (async function* (): AsyncIterable<unknown> {
    await new Promise<void>(() => undefined)
  })()
  const context: TestContext = {
    location: { directory: "/v2-test" },
    integration: {
      transform: async (callback) => { callback(integrationEditor); return registration() },
      connection: {
        active: async () => options.credential ? { type: "credential", id: "credential-1" } : undefined,
        resolve: async () => options.credential,
        status: async () => undefined,
      },
    },
    provider: {
      transform: async (callback) => { callback(providerEditor); return registration() },
      reload: vi.fn(async () => undefined),
    },
    model: {
      transform: async (callback) => { callback(modelEditor); return registration() },
    },
    aisdk: {
      hook: async (_name, callback) => { hooks.aisdk = callback; return registration() },
    },
    session: {
      hook: async (_name, callback) => { hooks.recovery = callback; return registration() },
    },
    tool: {
      transform: async (callback) => {
        callback({
          add: () => undefined,
        })
        return registration()
      },
    },
    event: { subscribe: () => options.events ?? noEvents },
  }
  return { context, hooks, providerModels }
}

async function setup(context: TestContext): Promise<() => Promise<void>> {
  const plugin = AntigravityV2Plugin as unknown as {
    setup: (input: TestContext) => Promise<(() => Promise<void>) | void>
  }
  const cleanup = await plugin.setup(context)
  if (!cleanup) throw new Error("V2 plugin did not return cleanup")
  return cleanup
}

function oauthRegistration(registrations: IntegrationMethodRegistration[]) {
  const registration = registrations.find((candidate) => candidate.method.type === "oauth")
  if (!registration || registration.method.type !== "oauth" || !("authorize" in registration)) {
    throw new Error("OAuth integration method was not registered")
  }
  return registration
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("AntigravityV2Plugin", () => {
  it("registers code OAuth and preserves custom provider models", async () => {
    const loader: LegacyLoader = { apiKey: "", fetch: vi.fn() }
    const legacy = buildLegacy({
      loader,
      authorization: {
        method: "code",
        callback: async (code) => ({ type: "success", refresh: `refresh-${code}`, access: "access-code", expires: 123 }),
      },
      definitions: {
        "antigravity-gemini": {
          name: "Gemini (Antigravity)",
          variants: {
            "high-thinking": {
              thinkingLevel: "high",
              thinkingConfig: { includeThoughts: true },
            },
          },
        },
      },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: true })
    const custom = providerModel("custom-model")
    const { context, hooks, providerModels } = createContext({ existingModels: [custom] })

    await setup(context)

    const oauth = oauthRegistration(hooks.integration)
    const authorization = await oauth.authorize({ noBrowser: true })
    expect(authorization.mode).toBe("code")
    if (authorization.mode !== "code") throw new Error("Expected code OAuth flow")
    await expect(authorization.callback("callback-code")).resolves.toMatchObject({
      type: "oauth",
      methodID: Integration.MethodID.make("antigravity"),
      refresh: "refresh-callback-code",
      access: "access-code",
      expires: 123,
    })
    expect(legacy.auth.methods[0]?.authorize).toHaveBeenCalledWith({ noBrowser: "true" })
    expect(hooks.integration.some((method) => method.method.type === "key")).toBe(true)
    expect(providerModels.map((model) => String(model.id))).toContain("custom-model")
    expect(providerModels.map((model) => String(model.id))).toContain("antigravity-gemini")
    const customPackage = `aisdk:${new URL("./google-provider.js", import.meta.url).href}`
    expect(custom.package).toBe(customPackage)
    const discovered = providerModels.find((model) => String(model.id) === "antigravity-gemini")
    expect(discovered?.package).toBe(customPackage)
    expect(discovered?.variants.map((variant) => ({ id: String(variant.id), settings: variant.settings }))).toContainEqual({
      id: "high-thinking",
      settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    })
  })

  it("registers automatic OAuth without a host refresh callback and maps API keys for the legacy loader", async () => {
    const loader: LegacyLoader = { apiKey: "", fetch: vi.fn() }
    const callback = vi.fn(async (): Promise<OAuthResult> => ({
      type: "success", refresh: "auto-refresh", access: "auto-access", expires: 222,
    }))
    const legacy = buildLegacy({ loader, authorization: { method: "auto", callback } })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: false })
    const { context, hooks } = createContext({ credential: { type: "key", key: "gemini-key" } })

    await setup(context)

    const oauth = oauthRegistration(hooks.integration)
    const authorization = await oauth.authorize({})
    expect(authorization.mode).toBe("auto")
    if (authorization.mode !== "auto") throw new Error("Expected automatic OAuth flow")
    await expect(authorization.callback).resolves.toMatchObject({
      type: "oauth",
      refresh: "auto-refresh",
      access: "auto-access",
      expires: 222,
    })
    expect(callback).toHaveBeenCalledOnce()
    expect(oauth.refresh).toBeUndefined()

    if (!hooks.aisdk) throw new Error("AISDK hook was not registered")
    const event = { options: {} as Record<string, unknown> }
    await hooks.aisdk(event)
    expect(legacy.auth.loader).toHaveBeenCalledOnce()
    expect(event.options.apiKey).toBe("antigravity-oauth")
  })

  it("forwards an expired OAuth credential to the legacy loader through the registered SDK hook", async () => {
    const expired = {
      type: "oauth" as const,
      refresh: "expired-refresh",
      access: "expired-access",
      expires: Date.now() - 60_000,
    }
    const receivedAuth: unknown[] = []
    const loader: LegacyLoader = { apiKey: "", fetch: vi.fn() }
    const legacy = buildLegacy({
      loader,
      loaderForAuth: async (getAuth) => {
        receivedAuth.push(await getAuth())
        return loader
      },
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: false })
    const { context, hooks } = createContext({ credential: expired })
    await setup(context)
    if (!hooks.aisdk) throw new Error("AISDK hook was not registered")

    await hooks.aisdk({ options: {} })

    expect(legacy.auth.loader).toHaveBeenCalledOnce()
    expect(receivedAuth).toEqual([expired])
  })

  it("shares concurrent loaders and makes the replacement SDK use the hooked transport", async () => {
    const received: Array<{ input: RequestInfo; init?: RequestInit }> = []
    const loader: LegacyLoader = {
      apiKey: "",
      fetch: vi.fn(async (input, init) => {
        received.push({ input, init })
        return googleResponse()
      }),
    }
    const legacy = buildLegacy({
      loader,
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: false })
    const { context, hooks } = createContext({ credential: { type: "oauth", refresh: "refresh", access: "access", expires: 999 } })
    await setup(context)
    if (!hooks.aisdk) throw new Error("AISDK hook was not registered")

    const first: AISDKEvent = { options: {} }
    const second: AISDKEvent = { options: {} }
    await Promise.all([hooks.aisdk(first), hooks.aisdk(second)])
    expect(legacy.auth.loader).toHaveBeenCalledOnce()
    if (!isGoogleDriverFactory(first.sdk)) throw new Error("AISDK SDK factory was not replaced")
    const model = first.sdk("gemini-3-pro-preview")
    const response = await model.doGenerate(generateOptions("high"))
    expect(response.content).toContainEqual(expect.objectContaining({ type: "text", text: "SDK transport response" }))
    expect(received).toHaveLength(1)
    expect(String(received[0]?.input)).toContain("generativelanguage.googleapis.com")
    const body = JSON.parse(await new Response(received[0]?.init?.body).text()) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } }
    }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true })
    const controller = new AbortController()
    const transport = first.options.fetch
    if (typeof transport !== "function") throw new Error("AISDK fetch transport was not installed")
    await transport(new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent", {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "abort test" }] }] }),
      signal: controller.signal,
    }))
    controller.abort()
    expect(received[1]?.init?.signal?.aborted).toBe(true)
  })

  it("uses the active credential loader when the same V2 SDK outlives an account switch", async () => {
    const usedLoaders: string[] = []
    const loaderA: LegacyLoader = {
      apiKey: "account-a",
      fetch: vi.fn(async () => {
        usedLoaders.push("account-a")
        return googleResponse()
      }),
    }
    const loaderB: LegacyLoader = {
      apiKey: "account-b",
      fetch: vi.fn(async () => {
        usedLoaders.push("account-b")
        return googleResponse()
      }),
    }
    let activeLoader = loaderA
    const legacy = buildLegacy({
      loader: loaderA,
      loaderForAuth: async () => activeLoader,
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: false })
    let credential: { type: "oauth"; refresh: string; access: string; expires: number } = {
      type: "oauth",
      refresh: "refresh-a",
      access: "access-a",
      expires: 999,
    }
    const { context, hooks } = createContext({ credential })
    context.integration.connection.resolve = async () => credential
    await setup(context)
    if (!hooks.aisdk) throw new Error("AISDK hook was not registered")

    const event: AISDKEvent = { options: {} }
    await hooks.aisdk(event)
    if (!isGoogleDriverFactory(event.sdk)) throw new Error("AISDK SDK factory was not replaced")
    const model = event.sdk("gemini-3-pro-preview")
    await model.doGenerate(generateOptions("high"))

    credential = {
      type: "oauth",
      refresh: "refresh-b",
      access: "access-b",
      expires: 999,
    }
    activeLoader = loaderB
    await model.doGenerate(generateOptions("medium"))

    expect(usedLoaders).toEqual(["account-a", "account-b"])
    expect(loaderA.fetch).toHaveBeenCalledOnce()
    expect(loaderB.fetch).toHaveBeenCalledOnce()
    expect(legacy.auth.loader).toHaveBeenCalledTimes(2)
  })

  it("accepts a replacement token on a revoked V2 connection without reusing the revoked token", async () => {
    const loader: LegacyLoader = { apiKey: "", fetch: vi.fn(async () => googleResponse()) }
    const receivedAuth: unknown[] = []
    const legacy = buildLegacy({
      loader,
      loaderForAuth: async (getAuth) => {
        receivedAuth.push(await getAuth())
        return loader
      },
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    let revoke: ((refreshToken: string) => Promise<void>) | undefined
    core.create.mockReturnValue(async (input: {
      client: { auth: { revoke: (refreshToken: string) => Promise<void> } }
    }) => {
      revoke = input.client.auth.revoke
      return legacy
    })
    core.loadConfig.mockReturnValue({ session_recovery: false })
    let credential = { type: "oauth" as const, refresh: "revoked", access: "old", expires: 1 }
    const { context, hooks } = createContext({ credential, events: (async function* () {})() })
    context.integration.connection.resolve = async () => credential
    context.integration.connection.status = vi.fn(async () => undefined)
    const cleanup = await setup(context)
    if (!hooks.aisdk || !revoke) throw new Error("V2 auth hooks were not registered")
    const event: AISDKEvent = { options: {} }
    await hooks.aisdk(event)
    if (!isGoogleDriverFactory(event.sdk)) throw new Error("AISDK SDK factory was not installed")
    const model = event.sdk("gemini-3-pro-preview")

    await revoke("revoked")
    await model.doGenerate(generateOptions("high"))
    expect(receivedAuth.at(-1)).toEqual({ type: "none" })
    expect(context.integration.connection.status).toHaveBeenCalledWith(expect.objectContaining({
      status: expect.objectContaining({ status: "needs_auth" }),
    }))

    credential = { ...credential, access: "refreshed-access" }
    await model.doGenerate(generateOptions("high"))
    expect(receivedAuth).toHaveLength(2)

    credential = { ...credential, refresh: "replacement-token" }
    await model.doGenerate(generateOptions("high"))
    expect(receivedAuth).toHaveLength(3)
    expect(receivedAuth.at(-1)).toEqual(credential)
    await revoke("revoked")
    await model.doGenerate(generateOptions("high"))
    expect(receivedAuth).toHaveLength(3)
    expect(context.integration.connection.status).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it("routes a cached SDK through OAuth after it was initialized before any connection existed", async () => {
    const oauthLoader: LegacyLoader = {
      apiKey: "",
      fetch: vi.fn(async () => googleResponse()),
    }
    let activeLoader: LegacyLoaderResult = {}
    const legacy = buildLegacy({
      loader: activeLoader,
      loaderForAuth: async () => activeLoader,
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: false })
    let credential: { type: "oauth"; refresh: string; access: string; expires: number } | undefined
    const { context, hooks } = createContext()
    context.integration.connection.active = async () => credential ? { type: "credential", id: "credential-1" } : undefined
    context.integration.connection.resolve = async () => credential
    await setup(context)
    if (!hooks.aisdk) throw new Error("AISDK hook was not registered")

    const event: AISDKEvent = { options: {} }
    await hooks.aisdk(event)
    if (!isGoogleDriverFactory(event.sdk)) throw new Error("AISDK SDK factory was not installed for an empty loader")
    const model = event.sdk("gemini-3-pro-preview")

    credential = {
      type: "oauth",
      refresh: "refresh-after-connect",
      access: "access-after-connect",
      expires: 999,
    }
    activeLoader = oauthLoader
    await model.doGenerate(generateOptions("high"))

    expect(oauthLoader.fetch).toHaveBeenCalledOnce()
    expect(legacy.auth.loader).toHaveBeenCalledTimes(2)
  })

  it("repairs an incomplete tool call in V2 session context", async () => {
    const legacy = buildLegacy({
      loader: { apiKey: "", fetch: vi.fn() },
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: true })
    const { context, hooks } = createContext()
    await setup(context)
    if (!hooks.recovery) throw new Error("Session context recovery was not registered")
    const recovery = hooks.recovery as unknown as (event: {
      messages: Array<{
        role: "assistant" | "tool"
        content: Array<Record<string, unknown>>
      }>
    }) => void
    const event = {
      messages: [{
        role: "assistant" as const,
        content: [{ type: "tool-call", id: "call-1", name: "read", providerExecuted: false }],
      }],
    }
    recovery(event)
    expect(event.messages).toHaveLength(2)
    expect(event.messages[1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", id: "call-1", name: "read", result: { type: "error" } }],
    })
  })

  it("aborts the event subscription and disposes the shared core during cleanup", async () => {
    let subscribedSignal: AbortSignal | undefined
    const events = (async function* (): AsyncIterable<unknown> {
      await new Promise<void>((resolve) => {
        subscribedSignal?.addEventListener("abort", () => resolve(), { once: true })
      })
    })()
    const legacy = buildLegacy({
      loader: { apiKey: "", fetch: vi.fn() },
      authorization: { method: "auto", callback: async (): Promise<OAuthResult> => ({ type: "success", refresh: "r", access: "a", expires: 1 }) },
    })
    core.create.mockReturnValue(async () => legacy)
    core.loadConfig.mockReturnValue({ session_recovery: false })
    const { context } = createContext({ events })
    context.event.subscribe = ({ signal }) => {
      subscribedSignal = signal
      return events
    }

    const cleanup = await setup(context)
    await vi.waitFor(() => expect(subscribedSignal).toBeDefined())
    await cleanup()
    expect(subscribedSignal?.aborted).toBe(true)
    expect(legacy.dispose).toHaveBeenCalledOnce()
  })
})
