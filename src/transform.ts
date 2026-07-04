import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";

export interface QoderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface QoderToolCall {
  id?: string;
  type: "function";
  function: { name?: string; arguments: string };
}

type QoderTextPart = { type: "text"; text: string };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart>;

export interface QoderMessage {
  role: "user" | "assistant" | "tool";
  content: QoderContent | null;
  tool_calls?: QoderToolCall[];
  tool_call_id?: string;
}

export interface TransformedPrompt {
  system: string;
  messages: QoderMessage[];
  lastUserText: string;
}

function dataContentToUrl(part: LanguageModelV3FilePart): string {
  if (part.data instanceof URL) return part.data.toString();
  if (typeof part.data === "string") {
    if (/^(https?:|data:)/i.test(part.data)) return part.data;
    return `data:${part.mediaType};base64,${part.data}`;
  }
  return `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`;
}

function stringifyToolResultOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ? `Execution denied: ${output.reason}` : "Execution denied";
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "file-url") return part.url;
          if (part.type === "file-id") return typeof part.fileId === "string" ? part.fileId : JSON.stringify(part.fileId);
          if (part.type === "image-url") return part.url;
          if (part.type === "image-file-id") return typeof part.fileId === "string" ? part.fileId : JSON.stringify(part.fileId);
          return "mediaType" in part ? `[${part.mediaType}]` : `[${part.type}]`;
        })
        .join("\n");
  }
}

function textFromContent(content: QoderContent | null): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function transformUserMessage(message: Extract<LanguageModelV3Message, { role: "user" }>): QoderMessage {
  const parts: Array<QoderTextPart | QoderImagePart> = [];
  let hasFile = false;

  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "file" && part.mediaType.startsWith("image/")) {
      hasFile = true;
      parts.push({ type: "image_url", image_url: { url: dataContentToUrl(part) } });
    }
  }

  return {
    role: "user",
    content: hasFile ? parts : parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
  };
}

function transformAssistantMessage(message: Extract<LanguageModelV3Message, { role: "assistant" }>): QoderMessage {
  let content = "";
  const toolCalls: QoderToolCall[] = [];

  for (const part of message.content) {
    if (part.type === "text") content += part.text;
    if (part.type === "reasoning") content += `<thinking>${part.text}</thinking>\n\n`;
    if (part.type === "tool-call") {
      toolCalls.push({
        id: part.toolCallId,
        type: "function",
        function: {
          name: part.toolName,
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
        },
      });
    }
  }

  const result: QoderMessage = { role: "assistant", content: content || null };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}

function transformToolMessage(message: Extract<LanguageModelV3Message, { role: "tool" }>): QoderMessage[] {
  return message.content.flatMap((part) => {
    if (part.type !== "tool-result") return [];
    return [
      {
        role: "tool" as const,
        tool_call_id: part.toolCallId,
        content: stringifyToolResultOutput(part.output),
      },
    ];
  });
}

export function transformPrompt(prompt: LanguageModelV3Prompt): TransformedPrompt {
  const system: string[] = [];
  const messages: QoderMessage[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "user") {
      messages.push(transformUserMessage(message));
      continue;
    }
    if (message.role === "assistant") {
      messages.push(transformAssistantMessage(message));
      continue;
    }
    if (message.role === "tool") messages.push(...transformToolMessage(message));
  }

  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    lastUserText = textFromContent(messages[i].content);
    break;
  }

  return { system: system.join("\n\n"), messages, lastUserText };
}

export function transformTools(tools: LanguageModelV3CallOptions["tools"]): { tools: QoderTool[]; ignoredTools: number } {
  if (!tools?.length) return { tools: [], ignoredTools: 0 };
  const result: QoderTool[] = [];
  let ignoredTools = 0;

  for (const tool of tools) {
    if (tool.type !== "function") {
      ignoredTools++;
      continue;
    }
    const functionTool = tool as LanguageModelV3FunctionTool;
    result.push({
      type: "function",
      function: {
        name: functionTool.name,
        description: functionTool.description,
        parameters: functionTool.inputSchema,
      },
    });
  }

  return { tools: result, ignoredTools };
}
