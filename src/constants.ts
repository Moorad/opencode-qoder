export const PROVIDER_ID = "qoder";
export const PROVIDER_NAME = "Qoder";

export const QODER_BASE_URL = "https://api3.qoder.sh/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.sh";
export const QODER_CENTER_URL = "https://center.qoder.sh";
export const QODER_MANAGE_URL = "https://qoder.com";

export const QODER_MODEL_LIST_URL = `${QODER_BASE_URL}algo/api/v2/model/list`;
export const QODER_CHAT_URL = `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_EXCHANGE_URL = `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_URL}/api/v1/userinfo`;
export const QODER_REFRESH_URL = `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;

export const QODER_PAT_ENV = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;
export const USER_AGENT = "opencode-qoder";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

export type QoderModelDefinition = {
  id: string;
  name: string;
  reasoning: boolean;
  supportsEffort: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

export const QODER_MODELS: QoderModelDefinition[] = [
  {
    id: "auto",
    name: "Qoder Auto",
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "ultimate",
    name: "Qoder Ultimate",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "performance",
    name: "Qoder Performance",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "efficient",
    name: "Qoder Efficient",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "lite",
    name: "Qoder Lite",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "qmodel",
    name: "Qwen3.7 Plus (Qoder)",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7 Max (Qoder)",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "dmodel",
    name: "DeepSeek V4 Pro (Qoder)",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "dfmodel",
    name: "DeepSeek V4 Flash (Qoder)",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gm51model",
    name: "GLM 5.1 (Qoder)",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "kmodel",
    name: "Kimi K2.6 (Qoder)",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 32768,
  },
  {
    id: "mmodel",
    name: "MiniMax M3 (Qoder)",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
  },
];

export function getModelDefinition(modelID: string): QoderModelDefinition {
  return QODER_MODELS.find((model) => model.id === modelID) ?? QODER_MODELS[0];
}
