import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAntigravityOnlyModelErrorResponse,
  enhanceAgySdkErrorResponse,
  extractRequestedGeminiModel,
  getAgySdkCredentials,
  fetchGeminiApiModels,
  isAgySdkSupportedRequest,
  isRetryableAgySdkCredentialStatus,
  isAntigravityOnlyGenerativeLanguageRequest,
  isLikelyAntigravityOnlyModel,
  prepareAgySdkGeminiRequest,
  selectAgySdkCredential,
  markAgySdkCredentialRateLimited,
  resetAgySdkCredentialStateForTests,
} from "./api-key";
import { DEFAULT_CONFIG, type AntigravityConfig } from "./config";
import { recordPublicGeminiApiModels, resetPublicGeminiApiModelCatalogForTests } from "./model-catalog";

function withConfig(overrides: Partial<AntigravityConfig>): AntigravityConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    agy_sdk: {
      ...DEFAULT_CONFIG.agy_sdk,
      ...overrides.agy_sdk,
    },
  };
}

async function readPreparedBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (typeof body === "string") return JSON.parse(body);
  return JSON.parse(await new Response(body).text());
}

describe("api-key agy sdk support", () => {
  beforeEach(() => {
    resetAgySdkCredentialStateForTests();
    resetPublicGeminiApiModelCatalogForTests();
  });

  it("retries another API key for credential failures, capacity, and transient 5xx responses", () => {
    // Given: responses that make the current key unusable, temporarily unavailable,
    // or that are transient upstream server errors (500/502/504) — none are terminal.
    const retryableStatuses = [401, 403, 429, 500, 502, 503, 504, 529];

    // When: classifying each response status
    const retryable = retryableStatuses.map(isRetryableAgySdkCredentialStatus);

    // Then: the credential loop can rotate to another configured key (and the OAuth
    // fallback guard sites can rotate to another account) instead of returning it.
    expect(retryable).toEqual(retryableStatuses.map(() => true));
  });

  it("does not rotate API keys for request and model errors", () => {
    // Given: errors unrelated to the selected credential (client/model errors).
    const nonRetryableStatuses = [400, 404, 501];

    // When: classifying each response status
    const retryable = nonRetryableStatuses.map(isRetryableAgySdkCredentialStatus);

    // Then: the response remains visible to the caller
    expect(retryable).toEqual([false, false, false]);
  });

  it("keeps image generation requests on Antigravity", () => {
    // Given: an image model request on the public Gemini hostname
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent";

    // When: checking whether the API-key route supports it
    const supported = isAgySdkSupportedRequest(url);

    // Then: the request remains on the Antigravity-only path
    expect(supported).toBe(false);
  });

  it("loads API key credentials from auth, config cloud projects, and environment", () => {
    vi.stubEnv("GEMINI_API_KEY", "env-key");
    vi.stubEnv("GOOGLE_API_KEY", "google-key");
    try {
      const credentials = getAgySdkCredentials(
        withConfig({
          agy_sdk: {
            ...DEFAULT_CONFIG.agy_sdk,
            cloud_projects: [
              { label: "backup", api_key: "config-key", project_id: "cloud-project", enabled: true },
            ],
          },
        }),
        { type: "api", key: "auth-key" },
      );

      expect(credentials).toEqual([
        { label: "opencode api key", apiKey: "auth-key" },
        { label: "backup", apiKey: "config-key", projectId: "cloud-project" },
        { label: "environment", apiKey: "env-key" },
        { label: "environment", apiKey: "google-key" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prepares public Gemini API requests with API key headers and no URL secret", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro-high:streamGenerateContent?alt=sse&key=old-url-key",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer oauth",
          "x-api-key": "old",
        },
        body: JSON.stringify({
          model: "ignored",
          contents: [],
          generationConfig: { temperature: 0.4 },
          providerOptions: {
            google: {
              thinkingLevel: "high",
              includeThoughts: false,
              googleSearch: { mode: "auto" },
            },
          },
        }),
      },
      { label: "backup", apiKey: "test-key", projectId: "cloud-project" },
    );

    expect(String(prepared.request)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
    );
    const headers = new Headers(prepared.init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("x-goog-user-project")).toBeNull();
    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [],
      generationConfig: {
        temperature: 0.4,
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: false,
        },
      },
      tools: [{ googleSearch: {} }],
    });
  });

  it("preserves Request input method, headers, and body when routing through API-key auth", async () => {
    const original = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?key=old-url-key",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer oauth",
          "x-request-id": "request-123",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    );

    const prepared = await prepareAgySdkGeminiRequest(
      original,
      undefined,
      { label: "backup", apiKey: "test-key", projectId: "cloud-project" },
    );

    const headers = new Headers(prepared.init.headers);
    expect(prepared.init.method).toBe("POST");
    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: "low",
          includeThoughts: true,
        },
      },
    });
    expect(headers.get("x-request-id")).toBe("request-123");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("adds default Gemini 3 thinking config without dropping extra body options", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          contents: [],
          generationConfig: {
            temperature: 0.2,
          },
          extra_body: {
            cachedContent: "cachedContents/example",
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.7,
            },
          },
        }),
      },
      { label: "env", apiKey: "test-key" },
    );

    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [],
      cachedContent: "cachedContents/example",
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        thinkingConfig: {
          thinkingLevel: "low",
          includeThoughts: true,
        },
      },
    });
  });

  it("keeps Gemini 3 tier suffix as thinking level while stripping it from the public API model", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro-high:generateContent",
      {
        method: "POST",
        body: JSON.stringify({ contents: [] }),
      },
      { label: "env", apiKey: "test-key" },
    );

    expect(String(prepared.request)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
    );
    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: true,
        },
      },
    });
  });

  it("preserves API-native preview model names for Gemini API requests", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
      {
        method: "POST",
        body: JSON.stringify({ contents: [] }),
      },
      { label: "env", apiKey: "test-key" },
    );

    expect(String(prepared.request)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
    );
  });

  it("accepts translatable Antigravity-only Gemini ids, rejects Claude and rate-limited keys", () => {
    // Public-API Gemini ids route to the API-key path directly.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")).toBe(true);

    // Antigravity-only bare Gemini ids and antigravity-prefixed variants are
    // ALSO routable now — prepareAgySdkGeminiRequest translates them to the
    // public-API equivalent (see mapAntigravityModelToPublicApi).
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-pro-high:generateContent")).toBe(true);
    // antigravity-gemini-3.5-flash strips to the bare public-API native gemini-3.5-flash.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent")).toBe(true);

    // Claude (and unmapped antigravity- prefixed ids) have no public-API equivalent.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent")).toBe(false);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-4-6:generateContent")).toBe(false);

    // Non-model URLs and untrusted hosts are not routable.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models")).toBe(false);
    expect(isAgySdkSupportedRequest("https://example.com/redirect?next=https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent")).toBe(false);

    const first = { label: "first", apiKey: "first" };
    const second = { label: "second", apiKey: "second" };
    markAgySdkCredentialRateLimited(first, 60_000);
    expect(selectAgySdkCredential([first, second])).toEqual(second);
  });

  it("isAntigravityOnlyGenerativeLanguageRequest flags only non-translatable Antigravity-only models", () => {
    // Non-translatable Antigravity-only ids → true. These short-circuit with
    // the synthetic 404 in api-key-only mode. Covers Claude ids and unknown
    // antigravity- prefixed non-Gemini ids (which `canRouteAsPublicGeminiApiModel`
    // rejects so they don't get raw-forwarded to Google).
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent")).toBe(true);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-4-6:generateContent")).toBe(true);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-mystery-model:generateContent")).toBe(true);

    // Translatable Antigravity-only Gemini ids → false. These fall through to
    // the api-key path via mapAntigravityModelToPublicApi.
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash:generateContent")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent")).toBe(false);
    // antigravity-gemini-3.5-flash falls through (strips to public-API native gemini-3.5-flash).
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent")).toBe(false);

    // Public-API Gemini ids → false (they CAN be served by the public API natively).
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")).toBe(false);

    // Wrong host or malformed → false
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://example.com/v1beta/models/claude-opus-4-6-thinking:generateContent")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("not a url")).toBe(false);
    expect(isAntigravityOnlyGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models")).toBe(false);
  });

  it("uses the live public model catalog as an additional positive signal, never a veto", () => {
    // Cold start (no catalog recorded yet): falls back to the static
    // ANTIGRAVITY_ONLY_BARE_GEMINI_IDS heuristic, which assumes any
    // non-denylisted bare id is public-API native.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent")).toBe(true);

    // A live catalog fetch can be incomplete (credential-scoped, a partial
    // page, briefly stale) — simulate that by recording a sparse list that
    // omits gemini-3-flash, which IS denylisted statically (Antigravity-only,
    // no public translation) and would 404 if actually routed there.
    recordPublicGeminiApiModels([
      { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
    ]);

    // Present in the live catalog → confirmed routable.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent")).toBe(true);

    // Absent from the (possibly-incomplete) live catalog must NOT flip an
    // otherwise-allowed static-heuristic case to rejected.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-9-made-up:generateContent")).toBe(true);

    // Explicit translations (e.g. gemini-3.1-pro → gemini-3.1-pro-preview) still
    // take priority over the catalog, even though the bare backend id itself
    // isn't in the public list.
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent")).toBe(true);
  });

  it("extractRequestedGeminiModel pulls the model id from a generativelanguage URL", () => {
    expect(extractRequestedGeminiModel("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent")).toBe("gemini-3.1-pro");
    expect(extractRequestedGeminiModel("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse")).toBe("gemini-3-pro-preview");
    expect(extractRequestedGeminiModel("https://generativelanguage.googleapis.com/v1beta/models")).toBeUndefined();
    expect(extractRequestedGeminiModel("not a url")).toBeUndefined();
  });

  it("resets API-key credential rotation and rate-limit state for isolated tests", () => {
    const first = { label: "first", apiKey: "first" };
    const second = { label: "second", apiKey: "second" };

    markAgySdkCredentialRateLimited(first, 60_000);
    expect(selectAgySdkCredential([first, second])).toEqual(second);

    resetAgySdkCredentialStateForTests();
    expect(selectAgySdkCredential([first, second])).toEqual(first);
  });

  it("fetches Gemini API models with API-key header and pagination", async () => {
    const requests: RequestInfo[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      requests.push(input);
      const url = new URL(String(input));
      if (!url.searchParams.get("pageToken")) {
        return new Response(JSON.stringify({
          models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
          nextPageToken: "next",
        }));
      }
      return new Response(JSON.stringify({
        models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["streamGenerateContent"] }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const models = await fetchGeminiApiModels({ label: "test", apiKey: "secret" });

      expect(models.map((model) => model.name)).toEqual([
        "models/gemini-2.5-flash",
        "models/gemini-2.5-pro",
      ]);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: { "x-goog-api-key": "secret" },
      });
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(String(requests[0])).toContain("pageSize=1000");
      expect(String(requests[1])).toContain("pageToken=next");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops Gemini API model pagination when the service repeats a page token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [],
      nextPageToken: "repeat",
    }))));

    try {
      await expect(fetchGeminiApiModels({ label: "test", apiKey: "secret" })).rejects.toThrow(
        "repeated page token",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops Gemini API model pagination after the maximum page count", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      page += 1;
      return new Response(JSON.stringify({
        models: [],
        nextPageToken: `next-${page}`,
      }));
    }));

    try {
      await expect(fetchGeminiApiModels({ label: "test", apiKey: "secret" })).rejects.toThrow(
        "exceeded 20 pages",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isLikelyAntigravityOnlyModel", () => {
  it("flags bare gemini-3.1-pro as Antigravity-only", () => {
    expect(isLikelyAntigravityOnlyModel("gemini-3.1-pro")).toBe(true);
  });

  it("flags antigravity- and claude- prefixed ids as Antigravity-only", () => {
    expect(isLikelyAntigravityOnlyModel("antigravity-gemini-3.1-pro")).toBe(true);
    expect(isLikelyAntigravityOnlyModel("antigravity-claude-sonnet-4-6")).toBe(true);
    expect(isLikelyAntigravityOnlyModel("claude-opus-4-6-thinking")).toBe(true);
  });

  it("does NOT flag public-API Gemini 3 ids (preview / lite / 3.5-flash)", () => {
    expect(isLikelyAntigravityOnlyModel("gemini-3.1-pro-preview")).toBe(false);
    expect(isLikelyAntigravityOnlyModel("gemini-3-pro-preview")).toBe(false);
    expect(isLikelyAntigravityOnlyModel("gemini-3.1-flash-lite")).toBe(false);
    expect(isLikelyAntigravityOnlyModel("gemini-3-flash-preview")).toBe(false);
    expect(isLikelyAntigravityOnlyModel("gemini-3.5-flash")).toBe(false);
  });

  it("does NOT flag Gemini 2.x ids", () => {
    expect(isLikelyAntigravityOnlyModel("gemini-2.5-pro")).toBe(false);
    expect(isLikelyAntigravityOnlyModel("gemini-2.5-flash")).toBe(false);
    expect(isLikelyAntigravityOnlyModel("gemini-2.0-flash")).toBe(false);
  });
});

describe("enhanceAgySdkErrorResponse", () => {
  function jsonResponse(body: unknown, status = 404): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function bodyOf(response: Response): Promise<{ error?: { message?: string; code?: number; status?: string } }> {
    return JSON.parse(await response.text());
  }

  it("returns the response unchanged for non-404 statuses", async () => {
    const original = jsonResponse({ error: { code: 500, message: "boom" } }, 500);
    const result = await enhanceAgySdkErrorResponse(original, "gemini-3.1-pro");
    expect(result).toBe(original);
  });

  it("returns the response unchanged when no model is provided", async () => {
    const original = jsonResponse({ error: { code: 404, message: "Model is not found" } });
    const result = await enhanceAgySdkErrorResponse(original, undefined);
    expect(result).toBe(original);
  });

  it("returns the response unchanged when body is not parseable as JSON", async () => {
    const original = new Response("<html>not found</html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
    const result = await enhanceAgySdkErrorResponse(original, "gemini-3.1-pro");
    expect(result).toBe(original);
  });

  it("rewrites 404 with text/event-stream content-type (streamGenerateContent?alt=sse case)", async () => {
    const original = new Response(JSON.stringify({
      error: {
        code: 404,
        message: "models/gemini-3.1-pro is not found for API version v1beta",
        status: "NOT_FOUND",
      },
    }), {
      status: 404,
      headers: { "content-type": "text/event-stream" },
    });
    const result = await enhanceAgySdkErrorResponse(original, "gemini-3.1-pro");
    expect(result).not.toBe(original);
    const enhanced = await bodyOf(result);
    expect(enhanced.error?.message).toContain("Antigravity Code Assist");
  });

  it("returns the response unchanged for 404s that don't look like model-not-found", async () => {
    const original = jsonResponse({ error: { code: 404, message: "Project not found" } });
    const result = await enhanceAgySdkErrorResponse(original, "gemini-3.1-pro");
    expect(result).toBe(original);
  });

  it("rewrites 404 with OAuth guidance for Antigravity-only models", async () => {
    const original = jsonResponse({
      error: {
        code: 404,
        message: "Model is not found: models/gemini-3.1-pro for api version v1beta",
        status: "NOT_FOUND",
      },
    });
    const result = await enhanceAgySdkErrorResponse(original, "gemini-3.1-pro");
    expect(result).not.toBe(original);
    expect(result.status).toBe(404);

    const enhanced = await bodyOf(result);
    expect(enhanced.error?.code).toBe(404);
    expect(enhanced.error?.status).toBe("NOT_FOUND");
    expect(enhanced.error?.message).toContain("gemini-3.1-pro");
    expect(enhanced.error?.message).toContain("Antigravity Code Assist backend");
    expect(enhanced.error?.message).toContain("opencode auth login");
    expect(enhanced.error?.message).toContain("api_key_fallback");
    expect(enhanced.error?.message).toContain("Public-API models known to work");
    expect(enhanced.error?.message).toContain("gemini-3.1-pro-preview");
    expect(enhanced.error?.message).toContain("(Underlying Gemini API error: Model is not found");
  });

  it("rewrites 404 with spelling/lookup hint for unknown non-Antigravity models", async () => {
    const original = jsonResponse({
      error: {
        code: 404,
        message: "Model is not found: models/gemini-nonexistent-v9 for api version v1beta",
        status: "NOT_FOUND",
      },
    });
    const result = await enhanceAgySdkErrorResponse(original, "gemini-nonexistent-v9");

    const enhanced = await bodyOf(result);
    expect(enhanced.error?.message).toContain("gemini-nonexistent-v9");
    expect(enhanced.error?.message).toContain("forwarded to the public Gemini API verbatim");
    expect(enhanced.error?.message).not.toContain("Antigravity Code Assist");
    expect(enhanced.error?.message).not.toContain("opencode auth login");
    expect(enhanced.error?.message).toContain("Public-API models known to work");
  });

  it("triggers on 'not supported for generateContent' phrasing too", async () => {
    const original = jsonResponse({
      error: {
        code: 404,
        message: "models/gemini-3.1-pro is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.",
        status: "NOT_FOUND",
      },
    });
    const result = await enhanceAgySdkErrorResponse(original, "gemini-3.1-pro");
    expect(result).not.toBe(original);
    const enhanced = await bodyOf(result);
    expect(enhanced.error?.message).toContain("Antigravity Code Assist");
  });

  it("preserves status, normalizes content-type to application/json, strips content-length", async () => {
    const original = new Response(JSON.stringify({
      error: { code: 404, message: "Model is not found", status: "NOT_FOUND" },
    }), {
      status: 404,
      statusText: "Not Found",
      headers: {
        "content-type": "text/event-stream",
        "content-length": "12345",
        "x-trace-id": "abc",
      },
    });
    const result = await enhanceAgySdkErrorResponse(original, "antigravity-gemini-3-flash");

    expect(result.status).toBe(404);
    expect(result.statusText).toBe("Not Found");
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.headers.get("content-length")).toBeNull();
    expect(result.headers.get("x-trace-id")).toBe("abc");
  });
});

describe("createAntigravityOnlyModelErrorResponse", () => {
  async function bodyOf(response: Response): Promise<{ error?: { message?: string; code?: number; status?: string } }> {
    return JSON.parse(await response.text());
  }

  it("returns a 404 NOT_FOUND envelope shaped like the public Gemini API error", async () => {
    const response = createAntigravityOnlyModelErrorResponse("gemini-3.1-pro");

    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Not Found");
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = await bodyOf(response);
    expect(body.error?.code).toBe(404);
    expect(body.error?.status).toBe("NOT_FOUND");
  });

  it("includes the Antigravity OAuth guidance for Antigravity-only models", async () => {
    const response = createAntigravityOnlyModelErrorResponse("gemini-3.1-pro");
    const body = await bodyOf(response);
    const message = body.error?.message ?? "";

    expect(message).toContain("gemini-3.1-pro");
    expect(message).toContain("Antigravity Code Assist backend");
    expect(message).toContain("opencode auth login");
    expect(message).toContain("api_key_fallback");
    expect(message).toContain("Public-API models known to work");
  });

  it("does NOT include the '(Underlying Gemini API error: ...)' line — there's no upstream cause", async () => {
    const response = createAntigravityOnlyModelErrorResponse("gemini-3.1-pro");
    const body = await bodyOf(response);
    expect(body.error?.message).not.toContain("Underlying Gemini API error");
  });

  it("falls back to the spelling/lookup hint for unknown non-Antigravity models", async () => {
    const response = createAntigravityOnlyModelErrorResponse("gemini-nonexistent-v9");
    const body = await bodyOf(response);
    const message = body.error?.message ?? "";

    expect(message).toContain("gemini-nonexistent-v9");
    expect(message).toContain("forwarded to the public Gemini API verbatim");
    expect(message).not.toContain("Antigravity Code Assist");
  });
});
