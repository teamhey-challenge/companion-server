import type { LlmProvider } from "../types";

export const anthropic: LlmProvider = {
  name: "anthropic",
  buildRequest(req, apiKey) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: req.model,
        max_tokens: req.maxTokens,
        stream: true,
        system: req.system,
        messages: [{ role: "user", content: req.userText }],
      },
    };
  },
  parseEvent(data) {
    const j = JSON.parse(data);
    if (j.type === "error") throw new Error(`anthropic: ${j.error?.message ?? "stream error"}`);
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta") return j.delta.text as string;
    return null;
  },
};
