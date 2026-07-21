import { extractVariantThinkingConfig } from "./request-helpers";
import { applyGeminiTransforms, isGemini3Model, isImageGenerationModel, mapAntigravityModelToPublicApi, resolveModelForHeaderStyle } from "./transform";
import { getPublicGeminiApiModelIds } from "./model-catalog";
import type { AntigravityConfig } from "./config";
import type { GeminiApiModel } from "./config/models";
import type { ApiKeyAuthDetails } from "./types";
import type { RequestPayload, ThinkingTier } from "./transform";

export interface AgySdkCredential {
  label: string;
  apiKey: string;
  projectId?: string;
}

export interface GeminiApiModelsResponse {
  models?: GeminiApiModel[];
  nextPageToken?: string;
}

interface PreparedAgySdkGeminiRequest {
  request: RequestInfo;
  init: RequestInit;
  model?: string;
}

const rateLimitedUntilByKey = new Map<string, number>();
let cursor = 0;

const GEMINI_MODELS_LIST_TIMEOUT_MS = 10000;
const GEMINI_MODELS_LIST_MAX_PAGES = 20;

export function isRetryableAgySdkCredentialStatus(status: number): boolean {
  // Credential-level or transient statuses where trying another API key (and, at
  // the OAuth fallback guard sites, rotating to another account) can still help:
  //   401/403  — this key is unauthorized/forbidden; another key may work.
  //   429/503/529 — rate-limited / overloaded; back off and try elsewhere.
  //   500/502/504 — transient upstream server errors; NOT terminal, so retry
  //   another key/account rather than surfacing them as a final failure.
  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529
  );
}

export function resetAgySdkCredentialStateForTests(): void {
  rateLimitedUntilByKey.clear();
  cursor = 0;
}

async function requestBodyText(request: Request): Promise<string | undefined> {
  if (!request.body) return undefined;
  try {
    return await request.clone().text();
  } catch {
    return undefined;
  }
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeCredentials(credentials: AgySdkCredential[]): AgySdkCredential[] {
  const seen = new Set<string>();
  const result: AgySdkCredential[] = [];
  for (const credential of credentials) {
    if (seen.has(credential.apiKey)) continue;
    seen.add(credential.apiKey);
    result.push(credential);
  }
  return result;
}

export function getAgySdkCredentials(
  config: AntigravityConfig,
  auth?: ApiKeyAuthDetails | null,
): AgySdkCredential[] {
  if (!config.agy_sdk.enabled) return [];

  const credentials: AgySdkCredential[] = [];
  if (auth?.key?.trim()) {
    credentials.push({ label: "opencode api key", apiKey: auth.key.trim() });
  }

  for (const project of config.agy_sdk.cloud_projects) {
    if (project.enabled === false) continue;
    credentials.push({
      label: project.label?.trim() || project.project_id?.trim() || "cloud project",
      apiKey: project.api_key.trim(),
      projectId: project.project_id?.trim() || undefined,
    });
  }

  const envKeys = splitEnvList(process.env.OPENCODE_ANTIGRAVITY_API_KEYS);
  const envCandidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    ...envKeys,
  ]
    .map((apiKey) => apiKey?.trim())
    .filter((apiKey): apiKey is string => Boolean(apiKey));
  for (const apiKey of envCandidates) {
    credentials.push({ label: "environment", apiKey });
  }

  return dedupeCredentials(credentials);
}

export function selectAgySdkCredential(credentials: AgySdkCredential[]): AgySdkCredential | null {
  if (credentials.length === 0) return null;
  const now = Date.now();
  for (let attempts = 0; attempts < credentials.length; attempts += 1) {
    const index = cursor % credentials.length;
    cursor += 1;
    const credential = credentials[index];
    if (!credential) continue;
    const limitedUntil = rateLimitedUntilByKey.get(credential.apiKey) ?? 0;
    if (limitedUntil <= now) {
      return credential;
    }
  }
  return null;
}

export function markAgySdkCredentialRateLimited(credential: AgySdkCredential, retryAfterMs: number): void {
  rateLimitedUntilByKey.set(credential.apiKey, Date.now() + Math.max(1000, retryAfterMs));
}

function retryAfterMsFromResponse(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallbackMs;
  const parsed = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed * 1000;
  }
  return fallbackMs;
}

export function isApiKeyAuth(auth: unknown): auth is ApiKeyAuthDetails {
  if (!auth || typeof auth !== "object") return false;
  const candidate = auth as ApiKeyAuthDetails;
  return (candidate.type === "api" || candidate.type === "api_key") && typeof candidate.key === "string";
}

/**
 * Classifies a model as servable by the public Gemini API via the api-key path,
 * either natively or via translation in `prepareAgySdkGeminiRequest`.
 *
 * Strips the optional `antigravity-` prefix and any tier suffix (-minimal/-low/
 * -medium/-high), then checks:
 *  - Claude models: never servable on the public API → returns false.
 *  - Has an explicit translation (e.g. `gemini-3.1-pro` → `gemini-3.1-pro-preview`)
 *    via `mapAntigravityModelToPublicApi` → routable.
 *  - Present in the live public model catalog (`GET v1beta/models`, cached from
 *    the `provider.models()` discovery fetch), when available → routable. This
 *    is checked as an ADDITIONAL positive signal only, never a veto: the live
 *    fetch can be incomplete (credential-scoped, a partial page, briefly stale
 *    after Google adds a model) and this whole path exists as a permissive
 *    last-resort fallback, so absence from a possibly-incomplete live snapshot
 *    must never override an otherwise-allowed static heuristic below.
 *  - Otherwise: stripped id NOT in the Antigravity-only denylist → assumed
 *    public-API native (covers `antigravity-gemini-3.5-flash` → `gemini-3.5-flash`,
 *    which the public API serves bare).
 *
 * Shared by `isAgySdkSupportedRequest` (positive gate) and
 * `isAntigravityOnlyGenerativeLanguageRequest` (negative gate / synthetic-404 trigger).
 */
function canRouteAsPublicGeminiApiModel(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("claude")) return false;
  const isAntigravityPrefixed = m.startsWith("antigravity-");
  const stripped = m.replace(/^antigravity-/, "").replace(/-(minimal|low|medium|high)$/, "");

  // Explicit translation (e.g. gemini-3.1-pro → gemini-3.1-pro-preview) → routable.
  if (mapAntigravityModelToPublicApi(stripped)) return true;

  // Live ground truth confirms routability when present, but its absence is
  // never treated as evidence of non-routability (see docstring above).
  if (getPublicGeminiApiModelIds()?.has(stripped)) return true;

  // For `antigravity-` prefixed inputs without a known mapping, require the
  // stripped id to look like a Gemini-family id. Unknown antigravity-* ids
  // (typos, hypotheticals) fall through to `isAntigravityOnlyGenerativeLanguageRequest`
  // which short-circuits with the synthetic OAuth re-auth guidance — better UX
  // than raw-forwarding to the public Gemini API and surfacing Google's 404.
  if (isAntigravityPrefixed) {
    return /^gemini-/.test(stripped) && !ANTIGRAVITY_ONLY_BARE_GEMINI_IDS.has(stripped);
  }

  // Bare (non-prefixed) inputs not in the Antigravity-only denylist are
  // assumed to be public-API natives (e.g. gemini-3.5-flash, gemini-2.5-pro).
  return !ANTIGRAVITY_ONLY_BARE_GEMINI_IDS.has(stripped);
}

/**
 * Returns true when the request can be routed to the public Gemini API
 * (`generativelanguage.googleapis.com`) via the api-key path — either natively
 * or via translation in `prepareAgySdkGeminiRequest`.
 *
 * Antigravity-only models with no public-API equivalent (Claude ids, unmapped
 * antigravity- prefixed non-Gemini ids) are excluded: the caller should stay on
 * the OAuth Antigravity path or short-circuit with a synthetic error.
 */
export function isAgySdkSupportedRequest(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.hostname !== "generativelanguage.googleapis.com") return false;
  const model = extractGeminiModelFromUrl(url.toString());
  if (!model || !model.toLowerCase().includes("gemini") || isImageGenerationModel(model)) return false;
  return canRouteAsPublicGeminiApiModel(model);
}

/**
 * Returns true when the URL targets `generativelanguage.googleapis.com` with an
 * Antigravity-only model that CANNOT be served by the public Gemini API even
 * with translation — Claude ids and unmapped antigravity- prefixed non-Gemini ids.
 *
 * Translatable Antigravity-only Gemini ids (e.g. `antigravity-gemini-3.1-pro`,
 * bare `gemini-3.1-pro`) and Antigravity-prefixed public-API natives (e.g.
 * `antigravity-gemini-3.5-flash` → `gemini-3.5-flash`) return false here —
 * `prepareAgySdkGeminiRequest` rewrites them to the public-API equivalent.
 *
 * Use this in API-key-only auth paths to short-circuit with a helpful synthetic
 * error (via `createAntigravityOnlyModelErrorResponse`) instead of forwarding to
 * the public Gemini API where it would 404.
 */
export function isAntigravityOnlyGenerativeLanguageRequest(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.hostname !== "generativelanguage.googleapis.com") return false;
  const model = extractGeminiModelFromUrl(url.toString());
  if (!model) return false;
  return isLikelyAntigravityOnlyModel(model) && !canRouteAsPublicGeminiApiModel(model);
}

/**
 * Extracts the requested model id from a `generativelanguage.googleapis.com`
 * URL (e.g. `.../v1beta/models/gemini-3.1-pro:generateContent` -> `gemini-3.1-pro`).
 * Returns `undefined` when the URL is malformed or doesn't match the model path.
 */
export function extractRequestedGeminiModel(urlString: string): string | undefined {
  return extractGeminiModelFromUrl(urlString);
}

/**
 * Public Gemini API models commonly available on `generativelanguage.googleapis.com/v1beta`.
 * Used to suggest alternatives when an Antigravity-only model is requested through
 * the API-key path. Kept short and stable; the live registry has more, but these
 * are the high-signal choices for the error hint.
 *
 * Source: GET https://generativelanguage.googleapis.com/v1beta/models (May 2026).
 */
const PUBLIC_GEMINI_API_MODEL_SUGGESTIONS = [
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
] as const;

/**
 * Bare Gemini ids that the Antigravity Code Assist backend serves but the public
 * Gemini API does NOT expose. Cross-checked against
 * `GET https://generativelanguage.googleapis.com/v1beta/models` (May 2026).
 *
 * The public registry DOES include `-preview` / `-lite` / `-image` / `-tts` variants,
 * and notably `gemini-3.5-flash` as a bare id, so this list stays explicit rather
 * than pattern-based to avoid false positives.
 */
const ANTIGRAVITY_ONLY_BARE_GEMINI_IDS: ReadonlySet<string> = new Set([
  "gemini-3.1-pro",
]);

/**
 * Classifies models that the Antigravity Code Assist backend serves but the public
 * Gemini API (v1beta on `generativelanguage.googleapis.com`) does not.
 *
 * Anything with the `antigravity-` prefix or any Claude model is OAuth-only by
 * construction. For Gemini ids we use an explicit denylist (see
 * `ANTIGRAVITY_ONLY_BARE_GEMINI_IDS`).
 */
export function isLikelyAntigravityOnlyModel(model: string): boolean {
  const m = model.toLowerCase();
  if (m.startsWith("antigravity-")) return true;
  if (m.includes("claude")) return true;
  return ANTIGRAVITY_ONLY_BARE_GEMINI_IDS.has(m);
}

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Builds the human-facing guidance message used by both
 * `enhanceAgySdkErrorResponse` (post-hoc, after a public-API 404) and
 * `createAntigravityOnlyModelErrorResponse` (pre-flight, before the round trip).
 *
 * When `originalMessage` is omitted, the trailing "(Underlying Gemini API error: ...)"
 * line is dropped so synthetic errors don't pretend to have a real upstream cause.
 */
function buildAntigravityModelGuidanceMessage(
  requestedModel: string,
  originalMessage?: string,
): string {
  const suggestions = PUBLIC_GEMINI_API_MODEL_SUGGESTIONS.join(", ");
  const antigravityOnly = isLikelyAntigravityOnlyModel(requestedModel);

  const lines: string[] = [
    `Model '${requestedModel}' was sent to the public Gemini API (v1beta) and rejected as NOT_FOUND.`,
  ];
  if (antigravityOnly) {
    lines.push(
      "",
      "This model id is served by the Antigravity Code Assist backend, not the public Gemini API.",
      "The plugin's API-key path forwarded the request unchanged because either:",
      "  • opencode's 'google' provider is in API-key mode (no OAuth session), or",
      "  • all OAuth Antigravity accounts were rate-limited and `agy_sdk.api_key_fallback` kicked in.",
      "",
      "To reach this model, re-authenticate with OAuth:",
      "  opencode auth logout google",
      "  opencode auth login   # choose Google → OAuth with Google (Antigravity)",
    );
  } else {
    lines.push(
      "",
      "The model id was forwarded to the public Gemini API verbatim. Double-check the spelling,",
      "or pick a model that's actually published on v1beta.",
    );
  }
  lines.push("", `Public-API models known to work: ${suggestions}.`);
  if (originalMessage) {
    lines.push("", `(Underlying Gemini API error: ${originalMessage})`);
  }
  return lines.join("\n");
}

/**
 * When the public Gemini API returns 404 NOT_FOUND for a model, rewrite the
 * response body with actionable guidance. Without this, users see a bare
 * "models/X is not found for API version v1beta" from Google and have no
 * indication that the plugin routed their request through the API-key path
 * because (a) opencode is in API-key mode for the google provider, or
 * (b) all OAuth accounts were rate-limited and `api_key_fallback` kicked in.
 *
 * The rewritten body preserves the JSON error envelope so `@ai-sdk/google` still
 * surfaces it as a normal `AI_APICallError` — only the human-facing message changes.
 */
export async function enhanceAgySdkErrorResponse(
  response: Response,
  requestedModel: string | undefined,
): Promise<Response> {
  if (response.status !== 404 || !requestedModel) return response;

  // NB: Gemini's `streamGenerateContent?alt=sse` returns 404 errors with a JSON
  // body but `Content-Type: text/event-stream`, so we can't gate on content-type.
  // Parse the body as JSON unconditionally; bail if it doesn't look like the
  // expected `{ error: { message } }` envelope.
  let body: GeminiErrorBody;
  try {
    body = JSON.parse(await response.clone().text()) as GeminiErrorBody;
  } catch {
    return response;
  }

  const originalMessage = body.error?.message ?? "";
  const looksLikeModelNotFound =
    /not (?:found|supported)/i.test(originalMessage) &&
    originalMessage.toLowerCase().includes("model");
  if (!looksLikeModelNotFound) return response;

  const enhanced: GeminiErrorBody = {
    error: {
      code: body.error?.code ?? 404,
      message: buildAntigravityModelGuidanceMessage(requestedModel, originalMessage),
      status: body.error?.status ?? "NOT_FOUND",
    },
  };

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // Body is now JSON regardless of the original (`text/event-stream` on SSE 404s);
  // normalize content-type so downstream parsers don't try to read it as a stream.
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(enhanced), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Synthesizes the same 404 guidance produced by `enhanceAgySdkErrorResponse`,
 * but pre-flight — before any request is sent to the public Gemini API.
 *
 * Use this in API-key-only auth paths when the requested model is identified by
 * `isLikelyAntigravityOnlyModel`: the round trip would deterministically 404,
 * so we short-circuit with the same Gemini-shaped error envelope. The shape
 * matches `enhanceAgySdkErrorResponse` so `@ai-sdk/google` raises a normal
 * `AI_APICallError` carrying the actionable message.
 */
export function createAntigravityOnlyModelErrorResponse(requestedModel: string): Response {
  const body: GeminiErrorBody = {
    error: {
      code: 404,
      message: buildAntigravityModelGuidanceMessage(requestedModel),
      status: "NOT_FOUND",
    },
  };
  return new Response(JSON.stringify(body), {
    status: 404,
    statusText: "Not Found",
    headers: { "content-type": "application/json" },
  });
}

function extractGeminiModelFromUrl(urlString: string): string | undefined {
  try {
    const url = new URL(urlString);
    return url.pathname.match(/\/models\/([^:]+):(\w+)/)?.[1];
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toThinkingTier(value: string | undefined): ThinkingTier | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function thinkingLevelFromBudget(budget: number): string {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

function mergeExtraBody(payload: RequestPayload): Record<string, unknown> | undefined {
  const extraBody = isRecord(payload.extra_body)
    ? payload.extra_body
    : isRecord(payload.extraBody)
      ? payload.extraBody
      : undefined;
  if (!extraBody) return undefined;

  if (isRecord(extraBody.generationConfig)) {
    const generationConfig = isRecord(payload.generationConfig) ? payload.generationConfig : {};
    for (const [key, value] of Object.entries(extraBody.generationConfig)) {
      if (!(key in generationConfig)) {
        generationConfig[key] = value;
      }
    }
    payload.generationConfig = generationConfig;
  }

  for (const [key, value] of Object.entries(extraBody)) {
    if (!(key in payload)) {
      payload[key] = value;
    }
  }
  return extraBody;
}

function applyAgySdkGeminiBodyTransforms(payload: RequestPayload, model: string, thinkingLevel?: string): void {
  const generationConfig = isRecord(payload.generationConfig)
    ? payload.generationConfig
    : {};
  const extraBody = mergeExtraBody(payload);
  const variantConfig = extractVariantThinkingConfig(
    isRecord(payload.providerOptions) ? payload.providerOptions : undefined,
    generationConfig,
  );

  const extraThinkingConfig = isRecord(extraBody?.thinkingConfig) ? extraBody.thinkingConfig : undefined;
  const existingThinkingConfig = isRecord(generationConfig.thinkingConfig)
    ? generationConfig.thinkingConfig
    : extraThinkingConfig
      ? { ...extraThinkingConfig }
      : {};

  if (isGemini3Model(model)) {
    const resolvedLevel = variantConfig?.thinkingLevel
      ?? (typeof existingThinkingConfig.thinkingLevel === "string" ? existingThinkingConfig.thinkingLevel : undefined)
      ?? (variantConfig?.thinkingBudget !== undefined ? thinkingLevelFromBudget(variantConfig.thinkingBudget) : undefined)
      ?? thinkingLevel
      ?? "low";
    existingThinkingConfig.thinkingLevel = resolvedLevel;
    if (variantConfig?.includeThoughts !== undefined) {
      existingThinkingConfig.includeThoughts = variantConfig.includeThoughts;
    } else if (typeof existingThinkingConfig.includeThoughts !== "boolean") {
      existingThinkingConfig.includeThoughts = true;
    }
  } else if (variantConfig?.thinkingBudget !== undefined || typeof existingThinkingConfig.thinkingBudget === "number") {
    existingThinkingConfig.thinkingBudget = variantConfig?.thinkingBudget ?? existingThinkingConfig.thinkingBudget;
    if (variantConfig?.includeThoughts !== undefined) {
      existingThinkingConfig.includeThoughts = variantConfig.includeThoughts;
    } else if (typeof existingThinkingConfig.includeThoughts !== "boolean") {
      existingThinkingConfig.includeThoughts = true;
    }
  }

  if (Object.keys(existingThinkingConfig).length > 0) {
    generationConfig.thinkingConfig = existingThinkingConfig;
    payload.generationConfig = generationConfig;
  }

  if (Array.isArray(payload.tools) || variantConfig?.googleSearch) {
    applyGeminiTransforms(payload, {
      model,
      tierThinkingLevel: toThinkingTier(typeof generationConfig.thinkingConfig === "object"
        && generationConfig.thinkingConfig
        && "thinkingLevel" in generationConfig.thinkingConfig
        ? String((generationConfig.thinkingConfig as Record<string, unknown>).thinkingLevel)
        : undefined),
      googleSearch: variantConfig?.googleSearch,
    });
  }

  delete payload.model;
  delete payload.providerOptions;
  delete payload.extra_body;
  delete payload.extraBody;
  delete payload.thinkingConfig;
  delete payload.thinking;
}

export async function prepareAgySdkGeminiRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  credential: AgySdkCredential,
): Promise<PreparedAgySdkGeminiRequest> {
  const requestInput = typeof input === "string" ? undefined : input;
  const urlString = requestInput?.url ?? input.toString();
  const url = new URL(urlString);
  const match = url.pathname.match(/\/models\/([^:]+):(\w+)/);
  const rawModel = match?.[1] ?? undefined;
  const action = match?.[2] ?? undefined;
  const resolved = rawModel ? resolveModelForHeaderStyle(rawModel, "agy-sdk") : undefined;

  if (resolved && action) {
    url.pathname = url.pathname.replace(`/models/${rawModel}:${action}`, `/models/${resolved.actualModel}:${action}`);
  }
  url.searchParams.delete("key");

  const headers = new Headers(init?.headers ?? requestInput?.headers ?? {});
  headers.delete("Authorization");
  headers.delete("x-api-key");
  headers.set("x-goog-api-key", credential.apiKey);
  headers.delete("x-goog-user-project");

  const requestTextBody = init?.body === undefined && requestInput ? await requestBodyText(requestInput) : undefined;
  const originalBody = init?.body ?? requestTextBody ?? requestInput?.body ?? undefined;
  let body = originalBody;
  if (typeof body === "string" && body.trim()) {
    try {
      const payload = JSON.parse(body) as RequestPayload;
      applyAgySdkGeminiBodyTransforms(payload, resolved?.actualModel ?? rawModel ?? "", resolved?.thinkingLevel);
      body = JSON.stringify(payload);
    } catch {
      body = originalBody;
    }
  }

  return {
    request: url.toString(),
    init: {
      method: requestInput?.method,
      ...init,
      headers,
      body,
    },
    model: resolved?.actualModel ?? rawModel,
  };
}

async function fetchGeminiModelsPage(url: string, credential: AgySdkCredential): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_MODELS_LIST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "x-goog-api-key": credential.apiKey,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithAgySdkCredential(
  input: RequestInfo,
  init: RequestInit | undefined,
  credential: AgySdkCredential,
  fallbackRetryAfterMs: number,
): Promise<Response> {
  const prepared = await prepareAgySdkGeminiRequest(input, init, credential);
  const response = await fetch(prepared.request, prepared.init);
  if (response.status === 429 || response.status === 503 || response.status === 529) {
    markAgySdkCredentialRateLimited(credential, retryAfterMsFromResponse(response, fallbackRetryAfterMs));
  }
  return enhanceAgySdkErrorResponse(response, prepared.model);
}

export async function fetchGeminiApiModels(credential: AgySdkCredential): Promise<GeminiApiModel[]> {
  const models: GeminiApiModel[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();

  for (let page = 0; page < GEMINI_MODELS_LIST_MAX_PAGES; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error(`Gemini models.list returned repeated page token for ${credential.label}`);
      }
      seenPageTokens.add(pageToken);
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchGeminiModelsPage(url.toString(), credential);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const snippet = body.trim().slice(0, 200);
      throw new Error(`Gemini models.list failed for ${credential.label}: ${response.status}${snippet ? ` ${snippet}` : ""}`);
    }

    const payload = (await response.json()) as GeminiApiModelsResponse;
    models.push(...(payload.models ?? []));
    pageToken = payload.nextPageToken;
    if (!pageToken) return models;
  }

  throw new Error(`Gemini models.list exceeded ${GEMINI_MODELS_LIST_MAX_PAGES} pages for ${credential.label}`);
}
