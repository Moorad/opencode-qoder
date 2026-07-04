import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
import {
  decodeOAuthRefresh,
  encodeOAuthRefresh,
  generatePKCE,
  type QoderCredentials,
  type QoderProviderOptions,
} from "./auth.js";
import { getMachineId } from "./cosy.js";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  QODER_BASE_URL,
  QODER_MODELS,
  QODER_OPENAPI_URL,
  QODER_PAT_ENV,
  USER_AGENT,
  ZERO_COST,
} from "./constants.js";
import { createQoder, QoderLanguageModel } from "./language-model.js";

export { createQoder, QoderLanguageModel };

type QoderPluginOptions = PluginOptions & {
  providerID?: string;
  setDefault?: boolean;
  apiKey?: string;
};

function optionString(options: PluginOptions | undefined, key: keyof QoderPluginOptions): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerID(options?: PluginOptions): string {
  return optionString(options, "providerID") || PROVIDER_ID;
}

function shouldSetDefault(options?: PluginOptions): boolean {
  return options?.setDefault === true;
}

function legacyModelConfig(model: (typeof QODER_MODELS)[number]) {
  return {
    name: model.name,
    reasoning: model.reasoning,
    tool_call: true,
    attachment: model.input.includes("image"),
    cost: ZERO_COST,
    limit: {
      context: model.contextWindow,
      input: model.contextWindow,
      output: model.maxTokens,
    },
    modalities: {
      input: model.input,
      output: ["text"],
    },
  };
}

function applyLegacyConfig(cfg: Record<string, any>, options?: PluginOptions): void {
  const id = providerID(options);
  cfg.provider ??= {};
  const current = (cfg.provider[id] ??= {});
  current.name ??= PROVIDER_NAME;
  current.env ??= [...QODER_PAT_ENV];
  current.npm ??= import.meta.url;
  current.options ??= {};
  current.options.baseURL ??= QODER_BASE_URL;
  const apiKey = optionString(options, "apiKey");
  if (apiKey && current.options.apiKey === undefined) current.options.apiKey = apiKey;
  current.models ??= {};

  for (const model of QODER_MODELS) {
    current.models[model.id] = {
      ...legacyModelConfig(model),
      ...(current.models[model.id] ?? {}),
    };
  }

  if (shouldSetDefault(options) && !cfg.model) cfg.model = `${id}/auto`;
}

function v2ModelConfig(model: (typeof QODER_MODELS)[number]) {
  return {
    name: model.name,
    family: model.id,
    api: {
      id: model.id,
      type: "aisdk" as const,
      package: "@ai-sdk/openai-compatible",
      url: QODER_BASE_URL,
      settings: {},
    },
    capabilities: {
      tools: true,
      input: model.input,
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active" as const,
    enabled: true,
    limit: {
      context: model.contextWindow,
      input: model.contextWindow,
      output: model.maxTokens,
    },
  };
}

async function authOptionsFromV2Connection(ctx: PluginContext, id: string): Promise<QoderProviderOptions> {
  const connection = await ctx.integration.connection.active(id);
  const credential = connection ? ((await ctx.integration.connection.resolve(connection)) as any) : undefined;
  if (!credential) return {};

  if (credential.type === "key") {
    return {
      apiKey: credential.key,
      qoderUserID: typeof credential.metadata?.userID === "string" ? credential.metadata.userID : undefined,
      qoderEmail: typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
      qoderName: typeof credential.metadata?.name === "string" ? credential.metadata.name : undefined,
      qoderMachineID: typeof credential.metadata?.machineID === "string" ? credential.metadata.machineID : undefined,
    };
  }

  if (credential.type === "oauth") {
    const decoded = decodeOAuthRefresh(credential.refresh || "");
    return {
      apiKey: credential.access,
      qoderUserID: typeof credential.metadata?.userID === "string" ? credential.metadata.userID : credential.accountId || decoded.userID,
      qoderEmail: typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
      qoderName: typeof credential.metadata?.name === "string" ? credential.metadata.name : undefined,
      qoderMachineID:
        typeof credential.metadata?.machineID === "string" ? credential.metadata.machineID : decoded.machineID,
    };
  }

  return {};
}

async function setupV2(ctx: PluginContext): Promise<void> {
  const id = providerID(ctx.options);
  await ctx.integration.transform((integrations) => {
    integrations.update(id, (integration) => {
      integration.name = PROVIDER_NAME;
    });
    integrations.method.update({ integrationID: id, method: { type: "key", label: "Qoder Personal Access Token" } });
    integrations.method.update({ integrationID: id, method: { type: "env", names: [...QODER_PAT_ENV] } });
  });

  await ctx.catalog.transform((catalog) => {
    catalog.provider.update(id, (provider) => {
      provider.name = PROVIDER_NAME;
      provider.integrationID = id;
      provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: QODER_BASE_URL, settings: {} };
      provider.request = { headers: {}, body: {} };
      const apiKey = optionString(ctx.options, "apiKey");
      if (apiKey) provider.request.body.apiKey = apiKey;
    });

    for (const model of QODER_MODELS) {
      catalog.model.update(id, model.id, (draft) => {
        Object.assign(draft, v2ModelConfig(model));
      });
    }

    if (shouldSetDefault(ctx.options)) catalog.model.default.set(id, "auto");
  });

  await ctx.aisdk.language(async (event) => {
    if (event.model.providerID !== id) return;
    const connectionOptions = await authOptionsFromV2Connection(ctx, id);
    event.language = new QoderLanguageModel(String(event.model.api.id), {
      ...event.options,
      ...connectionOptions,
      apiKey: connectionOptions.apiKey || optionString(ctx.options, "apiKey") || event.options.apiKey,
    });
  });
}

function abortableDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollDeviceFlow(codeVerifier: string, nonce: string, machineID: string): Promise<QoderCredentials> {
  const pollURL = `${QODER_OPENAPI_URL}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

  for (let attempt = 0; attempt < 90; attempt++) {
    await abortableDelay(2000);
    const response = await fetch(pollURL, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (response.status === 202 || response.status === 404) continue;
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Device token poll failed: ${response.status} ${response.statusText}. Response: ${errText}`);
    }

    const tokenData = (await response.json()) as {
      token?: string;
      user_id?: string;
      refresh_token?: string;
      expires_at?: string;
      expires_in?: number;
    };
    if (!tokenData.token) throw new Error("Device token poll returned empty access token");

    let email = "";
    let name = "";
    try {
      const userinfoRes = await fetch(`${QODER_OPENAPI_URL}/api/v1/userinfo`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenData.token}`, Accept: "application/json", "User-Agent": USER_AGENT },
      });
      if (userinfoRes.ok) {
        const userinfo = (await userinfoRes.json()) as { email?: string; name?: string; username?: string };
        email = userinfo.email || "";
        name = userinfo.name || userinfo.username || "";
      }
    } catch {}

    const parsedExpires = tokenData.expires_at ? Date.parse(tokenData.expires_at) : Number.NaN;
    const expires = Number.isFinite(parsedExpires)
      ? parsedExpires
      : Date.now() + (tokenData.expires_in || 30 * 24 * 60 * 60) * 1000;

    return {
      refresh: encodeOAuthRefresh(tokenData.refresh_token || "", tokenData.user_id || "", machineID),
      access: tokenData.token,
      expires: expires - 5 * 60 * 1000,
      userID: tokenData.user_id || "qoder-user",
      email: email || "user@qoder.com",
      name: name || "Qoder User",
      machineID,
    };
  }

  throw new Error("Authorization timed out");
}

function legacyHooks(options?: PluginOptions): Hooks {
  const id = providerID(options);
  return {
    config: async (cfg) => applyLegacyConfig(cfg as unknown as Record<string, any>, options),
    auth: {
      provider: id,
      loader: async (auth) => {
        const stored = (await auth()) as any;
        if (!stored) return {};
        if (stored.type === "api") {
          return {
            apiKey: stored.key,
            qoderUserID: stored.metadata?.userID,
            qoderEmail: stored.metadata?.email,
            qoderName: stored.metadata?.name,
            qoderMachineID: stored.metadata?.machineID,
          };
        }
        if (stored.type === "oauth") {
          const decoded = decodeOAuthRefresh(stored.refresh || "");
          return {
            apiKey: stored.access,
            qoderUserID: stored.accountId || decoded.userID,
            qoderMachineID: decoded.machineID,
          };
        }
        return {};
      },
      methods: [
        {
          type: "api",
          label: "Personal Access Token",
        },
        {
          type: "oauth",
          label: "Browser Login",
          authorize: async () => {
            const { codeVerifier, codeChallenge } = generatePKCE();
            const nonce = crypto.randomUUID();
            const machineID = getMachineId();
            const url = `https://qoder.com/device/selectAccounts?challenge=${codeChallenge}&challenge_method=S256&machine_id=${machineID}&nonce=${nonce}`;
            return {
              url,
              instructions: "Complete the Qoder browser login, then return to opencode.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const credential = await pollDeviceFlow(codeVerifier, nonce, machineID);
                  return {
                    type: "success" as const,
                    provider: id,
                    refresh: credential.refresh,
                    access: credential.access,
                    expires: credential.expires,
                    accountId: credential.userID,
                  };
                } catch {
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
      ],
    },
  };
}

const plugin = {
  id: "opencode-qoder",
  setup: setupV2,
  server: async (_input: PluginInput, options?: PluginOptions) => legacyHooks(options),
};

export default plugin;
