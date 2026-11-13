import type { LlmProvider } from "../types";
import { openai } from "./openai";

/** OpenAI 호환 게이트웨이(OmniRoute 등). LLM_BASE_URL 아래의 /chat/completions를 쓴다. */
export const openaiCompatible: LlmProvider = {
  name: "openai-compatible",
  buildRequest(req, apiKey) {
    if (!req.baseUrl) throw new Error("openai-compatible: LLM_BASE_URL 필요");
    const spec = openai.buildRequest(req, apiKey);
    const body: Record<string, unknown> = { ...(spec.body as Record<string, unknown>), max_tokens: req.maxTokens };
    // 게이트웨이는 max_completion_tokens를 모를 수 있어 호환성이 넓은 max_tokens를 쓴다.
    delete body.max_completion_tokens;
    return { ...spec, url: `${req.baseUrl.replace(/\/+$/, "")}/chat/completions`, body };
  },
  parseEvent: openai.parseEvent,
  parseModel(data) {
    if (data.trim() === "[DONE]") return null;
    const j = JSON.parse(data);
    // OmniRoute는 선두에 model="keepalive" 하트비트 청크를 보낸다. 실제 응답 청크만 본다.
    const m = j.model;
    return typeof m === "string" && m && m !== "keepalive" ? m : null;
  },
};
