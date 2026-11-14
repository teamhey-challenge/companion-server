import type { LlmProvider } from "../types";
import { openai } from "./openai";

/** OpenAI 호환 게이트웨이(OmniRoute 등). LLM_BASE_URL 아래의 /chat/completions를 쓴다. */
export const openaiCompatible: LlmProvider = {
  name: "openai-compatible",
  buildRequest(req, apiKey) {
    if (!req.baseUrl) throw new Error("openai-compatible: LLM_BASE_URL 필요");
    const spec = openai.buildRequest(req, apiKey);
    // 추론(thinking)을 끈다. 켜 두면 max_tokens 를 추론에 다 써서 content 가 비거나(→ OmniRoute 가 느린 deepseek 으로 넘김, 5~9초)
    // 추론 문장이 그대로 말로 새 나간다(2026-11-14 call_logs: reasoning 300/300 토큰, content null).
    const body: Record<string, unknown> = { ...(spec.body as Record<string, unknown>), max_tokens: req.maxTokens, thinking: { type: "disabled" } };
    // 게이트웨이는 max_completion_tokens를 모를 수 있어 호환성이 넓은 max_tokens를 쓴다.
    delete body.max_completion_tokens;
    // 추론 모델이 생각을 답 본문에 흘리거나 토큰을 다 써서 답이 잘리는 일을 막는다(안전 평가 2026-11-14: 62문장 중 6건). 짧은 대화에는 추론이 필요 없다.
    body.thinking = { type: "disabled" };
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
