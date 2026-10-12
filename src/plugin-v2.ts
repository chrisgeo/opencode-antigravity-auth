import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import type { Credential } from "@opencode/plugin"
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { createGoogleGenerativeAI } from "./google-provider.ts"
import { ANTIGRAVITY_PROVIDER_ID } from "./constants.ts"
import { createAntigravityPlugin } from "./plugin.ts"
import { loadConfig } from "./plugin/config/index.ts"
import { parseRefreshParts } from "./plugin/auth.ts"
import { createLogger } from "./plugin/logger.ts"
import { writeConsoleLog } from "./plugin/logging-utils.ts"
import type { OpencodeModelDefinition } from "./plugin/config/models.ts"
import type { AuthDetails, LoaderResult, PluginClient, ProviderModel } from "./plugin/types.ts"

const PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID
const METHOD_ID = "antigravity"
const GOOGLE_PACKAGE = `aisdk:${new URL("./google-provider.js", import.meta.url).href}`
const log = createLogger("opencode-v2")

function isLoader(value: LoaderResult | Record<string, unknown>): value is LoaderResult {
  return typeof value.fetch === "function"
}

function toModel(id: string, definition: ProviderModel): Model.Info {
  const model = definition as Partial<OpencodeModelDefinition>
  return {
    ...Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(id)),
    name: model.name ?? id,
    package: GOOGLE_PACKAGE,
    limit: model.limit ?? { context: 200_000, output: 32_000 },
    capabilities: {
      tools: true,
      input: model.modalities?.input ?? ["text", "image", "pdf"],
      output: model.modalities?.output ?? ["text"],
    },
    variants: Object.entries(model.variants ?? {}).map(([name, settings]) => ({
      id: Model.VariantID.make(name),
      settings: {
        thinkingConfig: {
          ...settings.thinkingConfig,
          ...(settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {}),
        },
      },
    })),
  }
}

// V2 repairs the request context rather than editing V1's JSON session files.
function recoverContext(event: SessionContext): void {
  const results = new Set(event.messages.flatMap((message) => message.content
    .filter((part) => part.type === "tool-result")
    .map((part) => part.id)))
  event.messages = event.messages.flatMap((message) => {
    const missing = message.content.filter((part) => part.type === "tool-call")
      .filter((part) => !part.providerExecuted && !results.has(part.id))
    if (missing.length === 0) return [message]
    return [message, {
      role: "tool" as const,
      content: missing.map((part) => ({
        type: "tool-result" as const,
        id: part.id,
        name: part.name,
        result: { type: "error" as const, value: "Operation cancelled before a tool result was recorded" },
      })),
    }]
  })
}

export const AntigravityV2Plugin = Plugin.define({
  id: "opencode-antigravity-auth",
  async setup(ctx) {
    const controller = new AbortController()
    const config = loadConfig(ctx.location.directory)
    let invalidConnection: { key: string | undefined; refresh: string } | undefined
    const connectionKey = (connection: Awaited<ReturnType<typeof ctx.integration.connection.active>>) =>
      connection?.type === "credential" ? connection.id : connection?.type === "env" ? connection.name : undefined

    const getAuth = async (): Promise<AuthDetails> => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      if (!connection) return { type: "none" }
      const credential = await ctx.integration.connection.resolve(connection)
      if (credential?.type === "oauth") {
        if (connectionKey(connection) === invalidConnection?.key && credential.refresh === invalidConnection?.refresh) {
          return { type: "none" }
        }
        return credential
      }
      if (credential?.type === "key") return { type: "api", key: credential.key }
      return { type: "none" }
    }

    // The shared transport only needs notifications and revocation reporting in
    // V2. Session recovery below uses the V2 context, never the V1 storage APIs.
    const client = {
      app: { log: async ({ body }: { body: { level: "debug" | "info" | "warn" | "error"; message: string } }) => {
        writeConsoleLog(body.level, body.message)
      } },
      tui: { showToast: async ({ body }: { body: { title?: string; message: string } }) => {
        writeConsoleLog("info", body.title ? `${body.title}: ${body.message}` : body.message)
      } },
      auth: { revoke: async (refreshToken: string) => {
        const connection = await ctx.integration.connection.active(PROVIDER_ID)
        if (!connection) return
        const credential = await ctx.integration.connection.resolve(connection)
        if (credential?.type !== "oauth" || parseRefreshParts(credential.refresh).refreshToken !== refreshToken) return
        // Quarantine the revoked token, not its reusable connection ID. A host
        // credential update can replace the token without creating a new ID.
        invalidConnection = { key: connectionKey(connection), refresh: credential.refresh }
        await ctx.integration.connection.status({
          integrationID: PROVIDER_ID,
          connection,
          status: { status: "needs_auth", message: "Google revoked the refresh token. Reconnect Antigravity." },
        })
      } },
    } as unknown as PluginClient

    const legacy = await createAntigravityPlugin(PROVIDER_ID)({
      client,
      directory: ctx.location.directory,
      runtime: "v2",
    })
    let loaderKey: string | undefined
    let loaderPromise: Promise<LoaderResult | Record<string, unknown>> | undefined
    const getLoader = async () => {
      const auth = await getAuth()
      const key = JSON.stringify([auth.type, "refresh" in auth ? auth.refresh : "key" in auth ? auth.key : undefined])
      if (!loaderPromise || key !== loaderKey) {
        loaderKey = key
        const pending = legacy.auth.loader(getAuth, { id: PROVIDER_ID })
        loaderPromise = pending
        // Clear failures so a transient connection error can be retried.
        void pending.catch(() => {
          if (loaderPromise === pending) loaderPromise = undefined
        })
      }
      return loaderPromise
    }

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: "OAuth with Google (Antigravity)",
          form: [{ key: "noBrowser", type: "boolean", title: "Paste the redirect URL manually", default: false }],
        },
        async authorize(answer): Promise<IntegrationOAuthAuthorization> {
          const method = legacy.auth.methods.find((method) => method.type === "oauth")
          if (!method?.authorize) throw new Error("Antigravity OAuth is unavailable")
          const authorization = await method.authorize({ noBrowser: String(answer.noBrowser ?? false) })
          const complete = async (code?: string): Promise<Credential.OAuth> => {
            const result = authorization.method === "auto"
              ? await authorization.callback()
              : await authorization.callback(code ?? "")
            if (result.type !== "success") throw new Error(result.error ?? "Antigravity authentication failed")
            invalidConnection = undefined
            loaderPromise = undefined
            return { type: "oauth", methodID: Integration.MethodID.make(METHOD_ID), refresh: result.refresh, access: result.access, expires: result.expires }
          }
          if (authorization.method === "code") {
            return { url: authorization.url, instructions: authorization.instructions, mode: "code", callback: complete }
          }
          const callback = complete()
          void callback.catch((error: unknown) => log.warn("OAuth callback failed", { error: String(error) }))
          return { url: authorization.url, instructions: authorization.instructions, mode: "auto", callback }
        },
        // Refresh belongs to the shared account pool. A host refresh would
        // abort model resolution on invalid_grant before rotation can run.
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: "Gemini API key (Antigravity SDK / Google AI)" },
      })
    })

    let sourceModels: Model.Info[] = []
    const discoverModels = async () => {
      const definitions = await legacy.provider?.models?.({ id: PROVIDER_ID }, { auth: await getAuth() }) ?? {}
      sourceModels = Object.entries(definitions).map(([id, definition]) => toModel(id, definition))
    }
    await discoverModels()
    await ctx.provider.transform((editor) => {
      const existing = editor.get(PROVIDER_ID)
      if (!existing) {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
            name: "Google (Antigravity)",
            integrationID: Integration.ID.make(PROVIDER_ID),
            package: GOOGLE_PACKAGE,
            activation: "enabled",
          },
          models: sourceModels,
        })
        return
      }
      editor.update(PROVIDER_ID, (provider) => {
        provider.package = GOOGLE_PACKAGE
        // The transport can also use accounts on disk or configured API keys.
        provider.activation = "enabled"
      })
      const models = new Map(existing.models)
      for (const model of sourceModels) {
        if (!models.has(model.id)) models.set(model.id, model)
      }
      editor.models.set(PROVIDER_ID, [...models.values()])
    })
    await ctx.model.transform((editor) => {
      for (const model of editor.list(PROVIDER_ID)) {
        editor.update(PROVIDER_ID, String(model.id), (model) => { model.package = GOOGLE_PACKAGE })
      }
    })
    await ctx.aisdk.hook("sdk", async (event) => {
      const loader = await getLoader()
      event.options.apiKey = (isLoader(loader) ? loader.apiKey : event.options.apiKey) || "antigravity-oauth"
      event.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        // V2 may retain this SDK across credential switches. Resolve the loader
        // for each request so its account pool follows the active connection.
        const currentLoader = await getLoader()
        // The shared interceptor reads init.body. Normalize one-shot Request
        // inputs from the SDK without consuming the caller's original body.
        const request = new Request(input, init)
        if (!isLoader(currentLoader)) {
          const auth = await getAuth()
          if (auth.type === "api" && typeof auth.key === "string") request.headers.set("x-goog-api-key", auth.key)
        }
        const fetchRequest = isLoader(currentLoader) ? currentLoader.fetch : globalThis.fetch
        return fetchRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ? await request.text() : undefined,
          signal: request.signal,
        })
      }
      // Built-in SDK initialization runs before external hooks. Recreate the
      // driver with the intercepted fetch, rather than mutating unused options.
      event.sdk = createGoogleGenerativeAI(event.options)
    }, { providerID: PROVIDER_ID })

    if (config.session_recovery) {
      await ctx.session.hook("context", recoverContext, { providerID: PROVIDER_ID })
    }
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(legacy.tool ?? {})) {
        const schema = z.object(definition.args)
        editor.add({
          name,
          description: definition.description,
          input: z.toJSONSchema(schema),
          async execute(input, context) {
            await getLoader()
            return { content: await definition.execute(schema.parse(input), {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              abort: context.signal,
            }) }
          },
        })
      }
    })

    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.created") {
            await legacy.event?.({ event: { type: event.type, properties: { info: {
              id: event.data.sessionID,
              parentID: event.data.parentID,
            } } } })
          } else if (event.type === "credential.updated" || event.type === "credential.switched") {
            loaderPromise = undefined
            await discoverModels()
            await ctx.provider.reload()
          }
        } catch (error: unknown) {
          if (!controller.signal.aborted) log.warn("Event handling failed", { type: event.type, error: String(error) })
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) log.warn("Event subscription failed", { error: String(error) })
    })
    return async () => {
      controller.abort()
      legacy.dispose?.()
      await events
    }
  },
})
