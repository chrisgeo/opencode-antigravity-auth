import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface ApiKeyAuthDetails {
  type: "api" | "api_key";
  key: string;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | ApiKeyAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModel {
  cost?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Provider {
  id?: string;
  api?: string;
  npm?: string;
  models?: Record<string, ProviderModel>;
}

export interface ProviderModelsContext {
  auth?: AuthDetails;
}

export interface ProviderHook {
  id: string;
  models?: (provider: Provider, context: ProviderModelsContext) => Promise<Record<string, ProviderModel>>;
}

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type PluginClient = {
  app: Pick<PluginInput["client"]["app"], "log">;
  tui: Pick<PluginInput["client"]["tui"], "showToast">;
  auth: Pick<PluginInput["client"]["auth"], "set"> & {
    revoke?: (refreshToken: string) => Promise<void>;
  };
  session: Pick<PluginInput["client"]["session"], "prompt" | "abort" | "messages">;
};

export interface PluginContext {
  client: PluginClient;
  directory: string;
  runtime?: "v1" | "v2";
}

export type AuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
      condition?: (inputs: Record<string, string>) => boolean;
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      condition?: (inputs: Record<string, string>) => boolean;
    };

export type OAuthAuthorizationResult = { url: string; instructions: string } & (
  | {
      method: "auto";
      callback: () => Promise<AntigravityTokenExchangeResult>;
    }
  | {
      method: "code";
      callback: (code: string) => Promise<AntigravityTokenExchangeResult>;
    }
);

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  prompts?: AuthPrompt[];
  authorize?: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationResult>;
}

export interface PluginEventPayload {
  event: {
    type: string;
    properties?: unknown;
  };
}

export interface PluginResult {
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | Record<string, unknown>>;
    methods: AuthMethod[];
  };
  event?: (payload: PluginEventPayload) => void;
  tool?: Record<string, ToolDefinition>;
  provider?: ProviderHook;
  dispose?: () => void;
}

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}
