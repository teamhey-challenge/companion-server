import type { LlmProvider } from "../types";

export const gemini: LlmProvider = {
  name: "gemini",
  buildRequest(req, apiKey) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.userText }] }],
        generationConfig: { maxOutputTokens: req.maxTokens },
      },
    };
  },
  parseEvent(data) {
    const j = JSON.parse(data);
    if (j.error) throw new Error(`gemini: ${j.error.message ?? "stream error"}`);
    const parts = j.candidates?.[0]?.content?.parts as { text?: string }[] | undefined;
    const t = parts?.map((p) => p.text ?? "").join("");
    return t ? t : null;
  },
};
