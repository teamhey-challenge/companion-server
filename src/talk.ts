import { parseClientFrame, MAX_TEXT_CHARS, type AudioSpec, type Ctx, type ErrorCode, type ServerFrame, type Trigger } from "../shared/packages/protocol/src/index";
import type { GuardConfig } from "./auth";
import type { RateLimiter } from "./rate-limit";
import { getProvider, KEY_VAR, streamLlm } from "./llm/providers";
import { loadSecrets } from "./llm/secrets";
import { PERSONA_DRAFT } from "./llm/persona";
import type { Observability } from "./observe";
import { AudioPipeline, PCM_FORMAT, Semaphore, SentenceSplitter, type TtsProvider } from "./tts";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  "openai-compatible": "chat-fast",
};

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

interface Turn {
  id: string;
  trigger: Trigger;
  text: string;
  ctx: Ctx;
  abort: AbortController;
  cancelled: boolean;
  running: boolean;
}

/** 업그레이드 때 붙이는 연결별 데이터. 티켓에서 온 installId·sessionId와 현재 턴 상태를 든다. */
export interface WsData {
  id: string;
  installId: string;
  sessionId: string;
  hello: boolean;
  turn?: Turn;
}

type Ws = { send(s: string | Uint8Array): unknown; close(code?: number, reason?: string): unknown; data: WsData };

export interface TalkGuard {
  guard: Pick<GuardConfig, "turnsPerMin" | "turnsPerDay">;
  limiter: RateLimiter;
  fetchImpl?: typeof fetch;
  /** null/undefined 이면 서버 TTS 없음(reply.start.audio = "none"). */
  tts?: TtsProvider | null;
}

/** 취소된 턴은 아무것도 더 보내지 않는다. */
function cancel(d: WsData, turnId?: string): void {
  const t = d.turn;
  if (!t || (turnId !== undefined && t.id !== turnId)) return;
  t.cancelled = true;
  t.abort.abort();
  d.turn = undefined;
}

function ctxLine(ctx: Ctx): string {
  const parts = Object.entries(ctx).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `\n\n[차량 상태] ${parts.join(", ")}` : "";
}

/** /v1/talk 웹소켓 핸들러. 텍스트 프레임(JSON)만 받는다. 앱→서버 바이너리는 1003으로 닫는다. */
export function talkHandlers(cfg: TalkConfig, observer: Observability, opts?: TalkGuard) {
  const provider = getProvider(cfg.providerName);
  const sem = new Semaphore();
  const send = (ws: Ws, f: ServerFrame) => void ws.send(JSON.stringify(f));
  const fail = (ws: Ws, code: ErrorCode, turnId?: string) => send(ws, turnId === undefined ? { type: "error", code } : { type: "error", code, turnId });

  async function run(ws: Ws, t: Turn): Promise<void> {
    const t0 = performance.now();
    if (opts) {
      try {
        opts.limiter.hit(`turn:${ws.data.id}`, opts.guard.turnsPerMin, 60_000);
        opts.limiter.hit("turn-day", opts.guard.turnsPerDay, 86_400_000);
      } catch {
        observer.reject("talk.rate_limited");
        return fail(ws, "rate_limited", t.id);
      }
    }
    if (!cfg.apiKey) return fail(ws, "no_key", t.id);
    t.running = true;
    const tts = opts?.tts ?? null;
    const emit = (f: ServerFrame) => {
      if (!t.cancelled) send(ws, f);
    };
    // reply.start 는 오디오 형식을 알려야 하므로, TTS 가 켜져 있으면 첫 문장의 첫 오디오(또는 실패)가 정해질 때 보낸다.
    // 그 전에 온 델타는 모아 두었다가 reply.start 직후에 보낸다.
    let started = false;
    let held: string[] = [];
    const start = (audio: AudioSpec) => {
      started = true;
      emit({ type: "reply.start", turnId: t.id, audio });
      for (const text of held) emit({ type: "reply.delta", turnId: t.id, text });
      held = [];
    };
    const pipeline = tts
      ? new AudioPipeline(tts, sem, t.abort.signal, {
          onStart: (ok) => {
            if (!ok) observer.event("tts.none", {});
            start(ok ? PCM_FORMAT : "none");
          },
          onChunk: (pcm) => {
            if (!t.cancelled) ws.send(pcm);
          },
          onError: (e) => observer.error("tts.failed", e.message),
        })
      : null;
    if (!pipeline) start("none");
    const splitter = new SentenceSplitter();
    let first: number | null = null;
    let full = "";
    const meta: { model?: string } = {};
    try {
      const req = { model: cfg.model, system: PERSONA_DRAFT + ctxLine(t.ctx), userText: t.text, maxTokens: cfg.maxTokens, baseUrl: cfg.baseUrl };
      for await (const d of streamLlm(provider, req, cfg.apiKey, opts?.fetchImpl ?? fetch, meta, t.abort.signal)) {
        if (t.cancelled) return;
        first ??= Math.round(performance.now() - t0);
        full += d;
        if (started) emit({ type: "reply.delta", turnId: t.id, text: d });
        else held.push(d);
        for (const s of splitter.push(d)) pipeline?.add(s);
      }
      for (const s of splitter.flush()) pipeline?.add(s);
      pipeline?.finish();
      await pipeline?.done;
      if (t.cancelled) return;
      if (!started) start("none");
      const totalMs = Math.round(performance.now() - t0);
      emit({ type: "reply.end", turnId: t.id, text: full, firstTokenMs: first, totalMs });
      observer.event("talk.turn", { firstTokenMs: first ?? -1, totalMs, chars: full.length, model: meta.model ?? cfg.model });
    } catch (e) {
      if (t.cancelled) return;
      t.abort.abort();
      pipeline?.finish();
      observer.error("talk.llm_failed", String((e as Error).message));
      send(ws, { type: "error", code: "llm_failed", turnId: t.id, message: String((e as Error).message).slice(0, 300) });
    } finally {
      if (ws.data.turn === t) ws.data.turn = undefined;
    }
  }

  return {
    open(ws: Ws) {
      observer.event("talk.open", { conn: ws.data.id.slice(0, 8) });
    },
    close(ws: Ws) {
      cancel(ws.data);
    },
    async message(ws: Ws, data: string | Buffer | ArrayBuffer | Uint8Array) {
      if (typeof data !== "string") {
        observer.reject("talk.binary_rejected");
        return void ws.close(1003, "TEXT_ONLY");
      }
      const p = parseClientFrame(data);
      if (!p.ok) return fail(ws, p.code);
      const f = p.value;
      const d = ws.data;
      if (f.type === "hello") {
        d.hello = true;
        return;
      }
      if (!d.hello) return fail(ws, "hello_required");
      switch (f.type) {
        case "turn.start":
          cancel(d);
          d.turn = { id: f.turnId, trigger: f.trigger, text: "", ctx: {}, abort: new AbortController(), cancelled: false, running: false };
          return;
        case "ctx": {
          const t = f.turnId === undefined ? d.turn : d.turn?.id === f.turnId ? d.turn : undefined;
          if (!t) return fail(ws, "turn_unknown", f.turnId);
          Object.assign(t.ctx, f.ctx);
          return;
        }
        case "text": {
          const t = d.turn;
          if (!t || t.id !== f.turnId || t.running) return fail(ws, "turn_unknown", f.turnId);
          const next = t.text ? `${t.text} ${f.text}` : f.text;
          if (next.length > MAX_TEXT_CHARS) return fail(ws, "text_too_long", f.turnId);
          t.text = next;
          return;
        }
        case "turn.cancel":
          return cancel(d, f.turnId);
        case "turn.end": {
          const t = d.turn;
          if (!t || t.id !== f.turnId || t.running) return fail(ws, "turn_unknown", f.turnId);
          if (!t.text.trim()) return fail(ws, "bad_frame", f.turnId);
          return run(ws, t);
        }
      }
    },
  };
}
