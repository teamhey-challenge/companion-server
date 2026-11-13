import type { HttpRequestSpec, LlmProvider, LlmRequest } from "../types";
import { sseData } from "../sse";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import { gemini } from "./gemini";
import { openaiCompatible } from "./openai-compatible";

export const providers: Record<string, LlmProvider> = { anthropic, openai, gemini, "openai-compatible": openaiCompatible };

export const KEY_VAR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  "openai-compatible": "LLM_API_KEY",
};

export function getProvider(name: string): LlmProvider {
  const p = providers[name];
  if (!p) throw new Error(`unknown LLM_PROVIDER '${name}' (anthropic|openai|openai-compatible|gemini)`);
  return p;
}

/** SSE 바이트 스트림 → 텍스트 델타. 테스트에서는 녹화된 fixture를 넣는다. */
export async function* parseStream(
  p: LlmProvider,
  body: AsyncIterable<Uint8Array>,
  meta?: { model?: string },
): AsyncGenerator<string> {
  for await (const data of sseData(body)) {
    if (meta && !meta.model && p.parseModel) meta.model = p.parseModel(data) ?? undefined;
    const t = p.parseEvent(data);
    if (t) yield t;
  }
}

export async function* streamLlm(
  p: LlmProvider,
  req: LlmRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  meta?: { model?: string },
): AsyncGenerator<string> {
  const spec: HttpRequestSpec = p.buildRequest(req, apiKey);
  const res = await fetchImpl(spec.url, {
    method: "POST",
    headers: spec.headers,
    body: JSON.stringify(spec.body),
  });
  if (!res.ok || !res.body) {
    // 응답 본문만 노출한다. 요청 헤더(키)는 절대 포함하지 않는다.
    const msg = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${p.name} HTTP ${res.status}: ${msg}`);
  }
  yield* parseStream(p, res.body as unknown as AsyncIterable<Uint8Array>, meta);
}
