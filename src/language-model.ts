import crypto from "node:crypto";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { resolveQoderCredentials, type QoderProviderOptions } from "./auth.js";
import { buildAuthHeaders } from "./cosy.js";
import { getModelDefinition, QODER_CHAT_URL, USER_AGENT } from "./constants.js";
import { qoderEncodeBody } from "./encoding.js";
import { transformPrompt, transformTools, type QoderMessage, type QoderTool } from "./transform.js";

type ToolCallState = {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  finished: boolean;
};

type QoderChunk = {
  id?: string;
  model?: string;
  created?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

const THINKING_TAG_VARIANTS = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(model: string, messages: QoderMessage[], tools: QoderTool[], maxTokens: number): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const message of messages) {
    hash.update("\0");
    hash.update(message.role);
    if (message.content) hash.update(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    if (message.tool_calls) hash.update(JSON.stringify(message.tool_calls));
  }
  if (tools.length) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

function mapFinishReason(raw: string | undefined, hasToolCalls: boolean): LanguageModelV3FinishReason {
  if (hasToolCalls || raw === "tool_calls" || raw === "function_call") return { unified: "tool-calls", raw };
  if (raw === "length") return { unified: "length", raw };
  if (raw === "content_filter") return { unified: "content-filter", raw };
  if (!raw || raw === "stop") return { unified: "stop", raw };
  return { unified: "other", raw };
}

function usageFromQoder(raw?: QoderChunk["usage"]): LanguageModelV3Usage {
  const promptTokens = raw?.prompt_tokens;
  const cachedTokens = raw?.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens !== undefined && cachedTokens !== undefined ? promptTokens - cachedTokens : undefined,
      cacheRead: cachedTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: raw?.completion_tokens,
      text: undefined,
      reasoning: raw?.completion_tokens_details?.reasoning_tokens,
    },
    raw: raw as any,
  };
}

function isParsableJson(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags) maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
  return maxLength;
}

class StreamEmitter {
  private textID: string | undefined;
  private reasoningID: string | undefined;
  private textIndex = 0;

  constructor(private controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {}

  text(delta: string): void {
    if (!delta) return;
    this.endReasoning();
    if (!this.textID) {
      this.textID = `txt-${this.textIndex++}`;
      this.controller.enqueue({ type: "text-start", id: this.textID });
    }
    this.controller.enqueue({ type: "text-delta", id: this.textID, delta });
  }

  endText(): void {
    if (!this.textID) return;
    this.controller.enqueue({ type: "text-end", id: this.textID });
    this.textID = undefined;
  }

  reasoning(delta: string): void {
    if (!delta) return;
    if (!this.reasoningID) {
      this.endText();
      this.reasoningID = "reasoning-0";
      this.controller.enqueue({ type: "reasoning-start", id: this.reasoningID });
    }
    this.controller.enqueue({ type: "reasoning-delta", id: this.reasoningID, delta });
  }

  endReasoning(): void {
    if (!this.reasoningID) return;
    this.controller.enqueue({ type: "reasoning-end", id: this.reasoningID });
    this.reasoningID = undefined;
  }

  closeOpenBlocks(): void {
    this.endReasoning();
    this.endText();
  }
}

class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private activeEndTag = THINKING_TAG_VARIANTS[0].close;

  constructor(private emitter: StreamEmitter) {}

  process(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;
      if (!this.inThinking && !this.thinkingExtracted) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.thinkingExtracted) {
        this.emitter.text(this.textBuffer);
        this.textBuffer = "";
        break;
      }
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (!this.textBuffer) return;
    if (this.inThinking) {
      this.emitter.reasoning(this.textBuffer);
      this.emitter.endReasoning();
    } else {
      this.emitter.text(this.textBuffer);
    }
    this.textBuffer = "";
  }

  private processBeforeThinking(): void {
    let bestPos = -1;
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | undefined;
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        bestVariant = variant;
      }
    }

    if (bestPos !== -1 && bestVariant) {
      if (bestPos > 0) this.emitter.text(this.textBuffer.slice(0, bestPos));
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
      this.activeEndTag = bestVariant.close;
      this.inThinking = true;
      return;
    }

    const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(
      this.textBuffer,
      THINKING_TAG_VARIANTS.map((variant) => variant.open),
    );
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitter.text(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitter.reasoning(this.textBuffer.slice(0, endPos));
      this.emitter.endReasoning();
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }

    const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitter.reasoning(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }
}

function buildRequestBody(modelID: string, options: LanguageModelV3CallOptions, userID: string): { body: Record<string, unknown>; warnings: SharedV3Warning[] } {
  const model = getModelDefinition(modelID);
  const transformed = transformPrompt(options.prompt);
  const { tools, ignoredTools } = transformTools(options.tools);
  const warnings: SharedV3Warning[] = [];

  if (ignoredTools > 0) warnings.push({ type: "unsupported", feature: "provider-defined tools" });
  if (options.stopSequences?.length) warnings.push({ type: "unsupported", feature: "stop sequences" });
  if (options.responseFormat?.type === "json") warnings.push({ type: "unsupported", feature: "JSON response format" });

  let maxTokens = model.maxTokens;
  if (options.maxOutputTokens && options.maxOutputTokens < maxTokens) maxTokens = options.maxOutputTokens;

  const recordID = stableChatRecordID(modelID, transformed.messages, tools, maxTokens);
  const sessionID = stableHash("qoder-session", userID, modelID);
  const parameters: Record<string, unknown> = { max_tokens: maxTokens };
  if (typeof options.temperature === "number") parameters.temperature = options.temperature;
  if (typeof options.topP === "number") parameters.top_p = options.topP;

  return {
    warnings,
    body: {
      request_id: crypto.randomUUID(),
      request_set_id: recordID,
      chat_record_id: recordID,
      session_id: sessionID,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: transformed.system,
      messages: transformed.messages,
      tools,
      parameters,
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: {
            key: modelID,
            is_reasoning: model.reasoning,
          },
          originalContent: transformed.lastUserText,
        },
        features: [],
        text: transformed.lastUserText,
      },
      model_config: {
        key: modelID,
        is_reasoning: model.reasoning,
        max_output_tokens: model.maxTokens,
        source: "system",
      },
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: crypto.randomUUID(),
        name: transformed.lastUserText.substring(0, 30),
        begin_at: Date.now(),
      },
    },
  };
}

function parseSSELine(line: string): QoderChunk | undefined {
  if (!line.startsWith("data:")) return undefined;
  const dataStr = line.substring(5).trim();
  if (!dataStr || dataStr === "[DONE]") return undefined;

  const envelope = JSON.parse(dataStr) as { statusCodeValue?: number; body?: string };
  if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
    throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
  }
  if (!envelope.body || envelope.body === "[DONE]") return undefined;
  return JSON.parse(envelope.body) as QoderChunk;
}

export class QoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "qoder";
  readonly supportedUrls = { "image/*": [/^data:/, /^https?:/] };

  constructor(
    readonly modelId: string,
    private readonly providerOptions: QoderProviderOptions = {},
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options);
    const content: LanguageModelV3Content[] = [];
    const textByID = new Map<string, { type: "text"; text: string }>();
    const reasoningByID = new Map<string, { type: "reasoning"; text: string }>();
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
    let usage = usageFromQoder();
    const warnings: SharedV3Warning[] = [];

    for await (const part of result.stream) {
      if (part.type === "stream-start") warnings.push(...part.warnings);
      if (part.type === "text-start") {
        const block = { type: "text" as const, text: "" };
        textByID.set(part.id, block);
        content.push(block);
      }
      if (part.type === "text-delta") textByID.get(part.id)!.text += part.delta;
      if (part.type === "reasoning-start") {
        const block = { type: "reasoning" as const, text: "" };
        reasoningByID.set(part.id, block);
        content.push(block);
      }
      if (part.type === "reasoning-delta") reasoningByID.get(part.id)!.text += part.delta;
      if (part.type === "tool-call") {
        content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = part.usage;
      }
      if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }

    return { content, finishReason, usage, warnings, request: result.request, response: result.response };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const credentials = await resolveQoderCredentials(this.providerOptions);
    const { body, warnings } = buildRequestBody(this.modelId, options, credentials.userID);
    const bodyBytes = Buffer.from(JSON.stringify(body));
    const encodedBody = qoderEncodeBody(bodyBytes);
    const encodedBytes = Buffer.from(encodedBody, "utf8");
    const headers = buildAuthHeaders(encodedBytes, QODER_CHAT_URL, {
      userID: credentials.userID,
      authToken: credentials.access,
      name: credentials.name,
      email: credentials.email,
      machineID: credentials.machineID,
    });

    const abortController = new AbortController();
    const abort = () => abortController.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) abort();
    else options.abortSignal?.addEventListener("abort", abort, { once: true });

    const response = await fetch(QODER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
        "X-Model-Key": this.modelId,
        "X-Model-Source": "system",
        ...headers,
      },
      body: encodedBytes,
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
    }

    const stream = this.responseToStream(response, warnings);
    return { stream, request: { body }, response: { headers: Object.fromEntries(response.headers.entries()) } };
  }

  private responseToStream(response: Response, warnings: SharedV3Warning[]): ReadableStream<LanguageModelV3StreamPart> {
    const modelID = this.modelId;
    return new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Qoder response body is empty");

        const decoder = new TextDecoder();
        const emitter = new StreamEmitter(controller);
        const tagParser = new ThinkingTagParser(emitter);
        const toolCalls: ToolCallState[] = [];
        let buffer = "";
        let rawFinishReason: string | undefined;
        let rawUsage: QoderChunk["usage"];
        let sawToolCall = false;

        const finishToolCall = (state: ToolCallState) => {
          if (!state.started || state.finished) return;
          state.finished = true;
          controller.enqueue({ type: "tool-input-end", id: state.id });
          controller.enqueue({ type: "tool-call", toolCallId: state.id, toolName: state.name, input: state.arguments });
          sawToolCall = true;
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            while (true) {
              const lineEnd = buffer.indexOf("\n");
              if (lineEnd === -1) break;
              const line = buffer.substring(0, lineEnd).trim();
              buffer = buffer.substring(lineEnd + 1);
              if (!line) continue;

              const chunk = parseSSELine(line);
              if (!chunk) continue;

              if (chunk.id || chunk.model || chunk.created) {
                controller.enqueue({
                  type: "response-metadata",
                  id: chunk.id,
                  modelId: chunk.model || modelID,
                  timestamp: chunk.created ? new Date(chunk.created * 1000) : undefined,
                });
              }
              if (chunk.usage) rawUsage = chunk.usage;

              const choice = chunk.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) rawFinishReason = choice.finish_reason;
              const delta = choice.delta;
              if (!delta) continue;

              if (delta.reasoning_content) emitter.reasoning(delta.reasoning_content);
              if (delta.content) tagParser.process(delta.content);

              if (delta.tool_calls) {
                tagParser.finalize();
                emitter.endReasoning();
                for (const toolCallDelta of delta.tool_calls) {
                  const index = toolCallDelta.index ?? 0;
                  const state =
                    toolCalls[index] ??
                    (toolCalls[index] = {
                      id: toolCallDelta.id || crypto.randomUUID(),
                      name: toolCallDelta.function?.name || "",
                      arguments: "",
                      started: false,
                      finished: false,
                    });
                  if (toolCallDelta.id) state.id = toolCallDelta.id;
                  if (toolCallDelta.function?.name) state.name = toolCallDelta.function.name;
                  if (!state.started && state.name) {
                    state.started = true;
                    controller.enqueue({ type: "tool-input-start", id: state.id, toolName: state.name });
                  }
                  const argDelta = toolCallDelta.function?.arguments || "";
                  if (argDelta) {
                    state.arguments += argDelta;
                    controller.enqueue({ type: "tool-input-delta", id: state.id, delta: argDelta });
                  }
                  if (state.started && isParsableJson(state.arguments)) finishToolCall(state);
                }
              }
            }
          }

          tagParser.finalize();
          emitter.closeOpenBlocks();
          for (const state of toolCalls) finishToolCall(state);
          controller.enqueue({
            type: "finish",
            finishReason: mapFinishReason(rawFinishReason, sawToolCall),
            usage: usageFromQoder(rawUsage),
            providerMetadata: { qoder: {} },
          });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: "error", error });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "error", raw: undefined },
            usage: usageFromQoder(rawUsage),
            providerMetadata: { qoder: {} },
          });
          controller.close();
        } finally {
          await reader.cancel().catch(() => {});
        }
      },
    });
  }
}

export function createQoder(options: QoderProviderOptions = {}): { languageModel(modelID: string): LanguageModelV3 } {
  return {
    languageModel(modelID: string) {
      return new QoderLanguageModel(modelID, options);
    },
  };
}
