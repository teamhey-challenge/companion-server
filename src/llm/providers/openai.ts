import type { LlmProvider } from "../types";

export const openai: LlmProvider = {
  name: "openai",
  buildRequest(req, apiKey) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: {
        model: req.model,
        max_completion_tokens: req.maxTokens,
        stream: true,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.userText },
        ],
      },
    };
  },
  parseEvent(data) {
    if (data.trim() === "[DONE]") return null;
    const j = JSON.parse(data);
    if (j.error) throw new Error(`openai: ${j.error.message ?? "stream error"}`);
    const t = j.choices?.[0]?.delta?.content;
    return typeof t === "string" && t.length ? t : null;
  },
};
