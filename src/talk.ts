import type { GuardConfig } from "./auth";
import type { RateLimiter } from "./rate-limit";
import { getProvider, KEY_VAR, streamLlm } from "./llm/providers";
import { loadSecrets } from "./llm/secrets";
import { PERSONA_DRAFT } from "./llm/persona";
import type { Observability } from "./observe";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  "openai-compatible": "chat-fast",
};

export const MAX_TEXT_CHARS = 500;
const FORBIDDEN = /^(lat|lng|lon|latitude|longitude|location|gps|position|coords?)$/i;

export type TurnCheck = { ok: true; text: string } | { ok: false; code: string };

/** turn 메시지 검증. ctx에 위치 필드가 있으면 거부. */
export function validateTurn(raw: unknown): TurnCheck {
  let m: any;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, code: "bad_json" };
  }
  if (!m || m.type !== "turn" || typeof m.text !== "string" || !m.text.trim()) return { ok: false, code: "bad_turn" };
  if (m.text.length > MAX_TEXT_CHARS) return { ok: false, code: "text_too_long" };
  if (m.ctx !== undefined) {
    if (typeof m.ctx !== "object" || m.ctx === null || Array.isArray(m.ctx)) return { ok: false, code: "bad_ctx" };
    if (Object.keys(m.ctx).some((k) => FORBIDDEN.test(k))) return { ok: false, code: "location_not_accepted" };
  }
  return { ok: true, text: m.text };
}

export interface TalkConfig {
  providerName: string;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  maxTokens: number;
}

/** 환경변수 + 600 권한 비밀 파일(~/.config/companion/server.env)에서 설정을 읽는다. 값은 로그에 남기지 않는다. */
export function loadTalkConfig(env: Record<string, string | undefined> = process.env): TalkConfig {
  const providerName = env.LLM_PROVIDER ?? "openai-compatible";
  getProvider(providerName);
  const secrets = loadSecrets();
  const pick = (k: string) => env[k] || secrets[k] || undefined;
  return {
    providerName,
    model: env.LLM_MODEL ?? DEFAULT_MODELS[providerName] ?? "chat-fast",
    apiKey: pick(KEY_VAR[providerName] ?? "LLM_API_KEY"),
    baseUrl: pick("LLM_BASE_URL"),
    maxTokens: Number(env.MAX_TURN_TOKENS ?? 300),
  };
}

type Ws = { send(s: string): unknown; close(code?: number, reason?: string): unknown; data?: WsData };

/** 업그레이드 때 붙이는 연결별 데이터. id는 연결 단위 한도의 키다. */
export interface WsData {
  id: string;
}

export interface TalkGuard {
  guard: Pick<GuardConfig, "turnsPerMin" | "turnsPerDay">;
  limiter: RateLimiter;
  fetchImpl?: typeof fetch;
}

/** /v1/talk 웹소켓 핸들러. 텍스트 프레임(JSON)만 받는다. 오디오(바이너리)는 1003으로 닫는다. */
export function talkHandlers(cfg: TalkConfig, observer: Observability, opts?: TalkGuard) {
  const provider = getProvider(cfg.providerName);
  const send = (ws: Ws, o: unknown) => void ws.send(JSON.stringify(o));
  return {
    async message(ws: Ws, data: string | Buffer | ArrayBuffer | Uint8Array) {
      if (typeof data !== "string") {
        observer.reject("talk.binary_rejected");
        return void ws.close(1003, "TEXT_ONLY");
      }
      const t0 = performance.now();
      const v = validateTurn(data);
      if (!v.ok) return send(ws, { type: "error", code: v.code });
      if (opts) {
        try {
          opts.limiter.hit(`turn:${ws.data?.id ?? "anon"}`, opts.guard.turnsPerMin, 60_000);
          opts.limiter.hit("turn-day", opts.guard.turnsPerDay, 86_400_000);
        } catch {
          observer.reject("talk.rate_limited");
          return send(ws, { type: "error", code: "rate_limited" });
        }
      }
      if (!cfg.apiKey) return send(ws, { type: "error", code: "no_key" });
      const meta: { model?: string } = {};
      send(ws, { type: "reply.start", provider: cfg.providerName, model: cfg.model });
      let first: number | null = null;
      let chars = 0;
      try {
        const req = { model: cfg.model, system: PERSONA_DRAFT, userText: v.text, maxTokens: cfg.maxTokens, baseUrl: cfg.baseUrl };
        for await (const d of streamLlm(provider, req, cfg.apiKey, opts?.fetchImpl ?? fetch, meta)) {
          first ??= Math.round(performance.now() - t0);
          chars += d.length;
          send(ws, { type: "reply.delta", text: d });
        }
        const totalMs = Math.round(performance.now() - t0);
        send(ws, { type: "reply.end", firstTokenMs: first, totalMs, chars, resolvedModel: meta.model ?? null });
        observer.event("talk.turn", { firstTokenMs: first ?? -1, totalMs, chars, model: meta.model ?? cfg.model });
      } catch (e) {
        observer.error("talk.llm_failed", String((e as Error).message));
        send(ws, { type: "error", code: "llm_failed", message: String((e as Error).message).slice(0, 300) });
      }
    },
  };
}
