import { describe, expect, it } from "vitest";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { transformPrompt, transformTools } from "../transform.js";

describe("transformPrompt", () => {
  it("maps system, user, assistant tool calls, and tool results", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are useful." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "I will call a tool." },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { file: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "contents" } },
        ],
      },
    ];

    expect(transformPrompt(prompt)).toEqual({
      system: "You are useful.",
      lastUserText: "hi",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "<thinking>thinking</thinking>\n\nI will call a tool.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: '{"file":"a.ts"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
    });
  });

  it("maps image files to OpenAI-compatible image_url parts", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "file", mediaType: "image/png", data: "aGVsbG8=" },
        ],
      },
    ];

    expect(transformPrompt(prompt).messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    });
  });
});

describe("transformTools", () => {
  it("maps function tools and counts unsupported provider tools", () => {
    const result = transformTools([
      { type: "function", name: "read", inputSchema: { type: "object" }, description: "Read a file" },
      { type: "provider", id: "qoder.web_search", name: "web_search", args: {} },
    ]);

    expect(result).toEqual({
      ignoredTools: 1,
      tools: [
        { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
      ],
    });
  });
});
