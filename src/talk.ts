import { parseClientFrame, MAX_TEXT_CHARS, type AudioSpec, type Ctx, type ErrorCode, type PairingStatus, type ServerFrame, type Settings, type SpeechStyle, type Trigger } from "../shared/packages/protocol/src/index";
import type { GuardConfig } from "./auth";
import { SystemClock, type Clock, type TimerHandle } from "./clock";
import { answerChat, answerNickname, answerSpeech, bestMatch, parseExtraction, parseForget, parseNicknameRequest, parseSpeechChange, recall, snippet } from "./intents";
import { getProvider, KEY_VAR, streamLlm } from "./llm/providers";
import { buildExtractRequest, buildSystem } from "./llm/persona";
import { loadSecrets } from "./llm/secrets";
import { L, forgetDone, nicknameSet, pick, rangeDestLine, withName } from "./lines";
import type { Observability } from "./observe";
import { ARRIVAL_DELAY_MS, MAX_MEMORY_RECALLS, RANGE_REFILLED_KM, detectEvents, eventAllowed, fuelKind, intervalMs, isNight, isPostpone, kstDay, newProState, wiperOn, type EventReason, type ProState, type Reason } from "./proactive";
import type { RateLimiter } from "./rate-limit";
import { checkInput, checkOutput, redirectLine } from "./safety";
import { InMemoryTalkStore, type TalkStore } from "./talk-store";
import { hedged } from "./llm/hedge";
import { recentForProactive } from "./memory-lines";
import { DRIVING_MAX_SENTENCES, PARKED_MAX_SENTENCES, SentenceCap, splitSentences } from "./sentence-cap";
import { AudioPipeline, FIRST_PIECE_OPTS, PCM_FORMAT, SentenceSplitter, TtsError, type TtsProvider } from "./tts";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  "openai-compatible": "chat-fast",
};

/** 첫 토큰이 이 시간 안에 안 오면, 미리 만들어 둔 짧은 채움말을 한 번 들려준다(차에서 약 1.5초 안에 소리가 나도록). */
const FILLER_AFTER_MS = 1200;
/** 한 턴이 LLM 에 쓸 수 있는 전체 시간. 넘으면 스트림을 끊고 `error llm_failed` 로 끝낸다(차의 30초 감시보다 짧다, PLEOS-134). */
const LLM_DEADLINE_MS = 20_000;
/** 말이 끝난 뒤 이 시간 동안은 새 먼저 말 걸기를 하지 않는다(재생이 아직 끝나지 않았을 수 있다). */
const QUIET_AFTER_REPLY_MS = 6000;
const FIRST_STOP_RETRY_MS = 1000;
const RECENT_TURNS = 6;
const PROACTIVE_MAX_TOKENS = 80;
/** 첫 토큰이 이 시간 안에 안 오면 같은 요청을 한 번 더 보내 먼저 오는 쪽을 쓴다(2026-11-14 측정: 정상 1.4~1.6초, 꼬리 4~9초). */
const HEDGE_AFTER_MS = 2000;

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
  /** 서버가 먼저 시작한 턴(사용자 입력 없음) */
  proactive?: boolean;
}

/** 연결 하나의 메모리 상태. 저장하지 않는다. */
interface Conn {
  ctx: Ctx;
  seen: boolean;
  pro: ProState;
  /** 첫 정차가 거절됐을 때 다시 시도하는 타이머. */
  firstStopRetry?: TimerHandle;
  /** 연결 직후 첫 ctx 가 기어 P 였다: 첫 정차 인사·첫 만남을 할 자리다. */
  firstStopArmed?: boolean;
  recent: { u: string; a: string }[];
  arrival?: TimerHandle;
  /** 마지막 답에 끼워 넣은 기억(그거 잊어줘의 "그거") */
  lastMemoryId?: string;
  quietUntil: number;
}

/** 업그레이드 때 붙이는 연결별 데이터. 티켓에서 온 installId·sessionId와 현재 턴 상태를 든다. */
export interface WsData {
  id: string;
  installId: string;
  sessionId: string;
  hello: boolean;
  turn?: Turn;
  conn?: Conn;
}

export type Ws = { send(s: string | Uint8Array): unknown; close(code?: number, reason?: string): unknown; data: WsData };

/** 차(installId)별 열린 소켓. 폰이나 목소리로 설정이 바뀌면 차 앱에 settings 프레임을 보낸다. */
export class TalkHub {
  private readonly socks = new Map<string, Set<Ws>>();
  add(ws: Ws): void {
    const set = this.socks.get(ws.data.installId) ?? new Set<Ws>();
    set.add(ws);
    this.socks.set(ws.data.installId, set);
  }
  remove(ws: Ws): void {
    const set = this.socks.get(ws.data.installId);
    set?.delete(ws);
    if (set?.size === 0) this.socks.delete(ws.data.installId);
  }
  pushSettings(installId: string, settings: Settings): void {
    const msg = JSON.stringify({ type: "settings", settings } satisfies ServerFrame);
    for (const ws of this.socks.get(installId) ?? []) ws.send(msg);
  }
  pushPairing(installId: string, status: PairingStatus): void {
    const msg = JSON.stringify({ type: "pairing", status } satisfies ServerFrame);
    for (const ws of this.socks.get(installId) ?? []) ws.send(msg);
  }
  /** talkHandlers 가 건다: 동의가 바뀔 때마다 그 차의 각 소켓에 부른다(withdrawn: 철회인가). */
  onConsent?: (ws: Ws, withdrawn: boolean) => void;
  /** 동의가 바뀌었다: 허용이면 첫 정차를 다시 보고, 철회면 진행 중인 것을 끊는다. */
  consentChanged(installId: string, withdrawn: boolean): void {
    for (const ws of this.socks.get(installId) ?? []) this.onConsent?.(ws, withdrawn);
  }
}

export interface TalkGuard {
  guard: Pick<GuardConfig, "turnsPerMin" | "turnsPerDay">;
  limiter: RateLimiter;
  fetchImpl?: typeof fetch;
  /** null/undefined 이면 서버 TTS 없음(reply.start.audio = "none"). */
  tts?: TtsProvider | null;
  /** 기억·설정·대화 상태. 없으면 프로세스 메모리 저장소. */
  store?: TalkStore;
  hub?: TalkHub;
  clock?: Clock;
  /** 기어가 P가 된 뒤 도착 인사까지(F10, 기본 3초). 시험에서만 바꾼다. */
  arrivalDelayMs?: number;
  /** 첫 토큰이 이 시간 안에 안 오면 채움말을 낸다(기본 1.2초). 시험에서만 바꾼다. */
  fillerAfterMs?: number;
  /** 한 턴이 LLM 에 쓸 수 있는 전체 시간(기본 20초). 시험에서만 바꾼다. */
  llmDeadlineMs?: number;
  /** 기억 담은 먼저 말이 첫 글자를 이 시간 안에 못 받으면 고정 문장으로 말한다(기본 3.5초). 시험에서만 바꾼다. */
  proactiveLlmFirstMs?: number;
}

/** 취소된 턴은 아무것도 더 보내지 않는다. */
function cancel(d: WsData, turnId?: string): void {
  const t = d.turn;
  if (!t || (turnId !== undefined && t.id !== turnId)) return;
  t.cancelled = true;
  t.abort.abort();
  d.turn = undefined;
}

/** 정차 판정은 fail-closed: 기어를 모르면 주행으로 본다. */
export const isParked = (ctx: Ctx): boolean => ctx.gear === "P" && !(typeof ctx.speedKmh === "number" && ctx.speedKmh > 0);

/** 한 턴에서 할 일. text 가 있으면 그대로 말하고, llm 이 있으면 모델에게 시킨다. */
interface Plan {
  text?: string;
  llm?: { system: string; userText: string; maxTokens: number; /** 모델이 NONE 이라고 하면 대신 말할 문장 */ fallback?: string };
  /** 기억 추출에 쓸 사용자 말(없으면 추출 안 함) */
  extractFrom?: string[];
  driving: boolean;
  speech: SpeechStyle;
  userText: string;
}

/** 먼저 말 걸기 LLM 이 이 시간 안에 첫 글자를 못 내면 고정 문장으로 대신한다(차가 한참 말이 없는 것보다 낫다). */
const PROACTIVE_LLM_FIRST_MS = 3500;

/**
 * 모델 출력이 NONE 이면 fallback 으로 바꾼다. 앞 몇 글자를 먼저 모아 판단하므로 NONE 은 소리로 나가지 않는다.
 * 첫 글자가 firstMs 안에 안 오면 onSlow() 로 모델을 끊고 fallback 을 낸다.
 */
async function* noneGuard(src: AsyncIterable<string>, fallback: string, firstMs: number, onSlow: () => void): AsyncGenerator<string> {
  const it = src[Symbol.asyncIterator]();
  let head = "";
  let decided = false;
  const { promise: slow, resolve: wake } = Promise.withResolvers<"slow">();
  const firstTimer = setTimeout(() => wake("slow"), firstMs);
  try {
    while (true) {
      const r = decided ? await it.next() : await Promise.race([it.next(), slow]);
      if (r === "slow") {
        onSlow();
        void it.return?.(undefined)?.catch?.(() => undefined);
        yield fallback;
        return;
      }
      if (r.done) break;
      if (decided) {
        yield r.value;
        continue;
      }
      head += r.value;
      if (head.trim().length < 4) continue;
      decided = true;
      clearTimeout(firstTimer);
      if (/^NONE/i.test(head.trim())) return void (yield fallback);
      yield head;
    }
    if (!decided) yield /^NONE/i.test(head.trim()) || !head.trim() ? fallback : head;
  } catch (e) {
    // 먼저 말 걸기는 모델이 실패해도 고정 문장으로 말한다(아직 아무것도 말하지 않았을 때만).
    if (decided) throw e;
    yield fallback;
  } finally {
    clearTimeout(firstTimer);
  }
}

/** /v1/talk 웹소켓 핸들러. 텍스트 프레임(JSON)만 받는다. 앱→서버 바이너리는 1003으로 닫는다. */
export function talkHandlers(cfg: TalkConfig, observer: Observability, opts?: TalkGuard) {
  const provider = getProvider(cfg.providerName);
  const store: TalkStore = opts?.store ?? new InMemoryTalkStore();
  const hub = opts?.hub ?? new TalkHub();
  const clock = opts?.clock ?? new SystemClock();
  const arrivalDelay = opts?.arrivalDelayMs ?? ARRIVAL_DELAY_MS;
  const fillerAfter = opts?.fillerAfterMs ?? FILLER_AFTER_MS;
  const llmDeadline = opts?.llmDeadlineMs ?? LLM_DEADLINE_MS;
  const proactiveFirstMs = opts?.proactiveLlmFirstMs ?? PROACTIVE_LLM_FIRST_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const send = (ws: Ws, f: ServerFrame) => void ws.send(JSON.stringify(f));
  const fail = (ws: Ws, code: ErrorCode, turnId?: string) => send(ws, turnId === undefined ? { type: "error", code } : { type: "error", code, turnId });

  const conn = (d: WsData): Conn =>
    (d.conn ??= {
      ctx: {}, seen: false, pro: newProState(), recent: [], quietUntil: 0,
    });

  /** record·external_ai 철회: 대기 중인 도착 타이머와 진행 중인 턴(먼저 말 걸기 포함)을 바로 끊고 차 앱에 알린다(AC-4.9-05). */
  function revokeTalk(ws: Ws): void {
    const d = ws.data;
    if (store.talkAllowed(d.installId)) return;
    if (d.conn) {
      clearArrival(d.conn);
      clearFirstStopRetry(d.conn);
    }
    const t = d.turn;
    if (t) {
      cancel(d, t.id);
      observer.reject("talk.consent_withdrawn");
      fail(ws, "consent_required", t.id);
    }
  }

  async function* llmText(system: string, userText: string, maxTokens: number, signal: AbortSignal, meta?: { model?: string }): AsyncGenerator<string> {
    const req = { model: cfg.model, system, userText, maxTokens, baseUrl: cfg.baseUrl };
    yield* hedged((leg) => streamLlm(provider, req, cfg.apiKey!, fetchImpl, leg.meta, AbortSignal.any([signal, leg.signal])), HEDGE_AFTER_MS, signal, meta);
  }

  /** 대화가 끝난 뒤 운전자가 직접 말한 것만 기억으로 남긴다(원문은 저장하지 않는다). 철회·끄기는 쓰기 직전에 다시 본다. */
  async function extractMemory(installId: string, userTexts: string[]): Promise<void> {
    const latest = userTexts.at(-1) ?? "";
    if (!cfg.apiKey || latest.trim().length < 6 || !store.memoryAllowed(installId)) return;
    const existing = store.listMemory(installId, 30).map((m) => m.text);
    const req = buildExtractRequest(existing, userTexts);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      let out = "";
      for await (const d of llmText(req.system, req.user, 160, ctl.signal)) out += d;
      const items = parseExtraction(out, existing);
      if (!items.length || !store.memoryAllowed(installId)) return;
      for (const it of items) store.addMemory(installId, it.kind, it.text);
      observer.event("memory.added", { n: items.length });
    } catch (e) {
      observer.error("memory.extract_failed", String((e as Error).message).slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 턴을 실제로 말한다: 문장 단위로 안전 검사 → 자막 델타 → TTS. */
  async function deliver(ws: Ws, t: Turn, plan: Plan): Promise<void> {
    const t0 = performance.now();
    const c = conn(ws.data);
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
    let ttsCause = "none";
    let firstAudio: number | null = null;
    let fillerMs: number | null = null;
    const pipeline = tts
      ? new AudioPipeline(tts, t.abort.signal, {
          onStart: (ok) => {
            if (!ok) observer.event("tts.none", { cause: ttsCause });
            start(ok ? PCM_FORMAT : "none");
          },
          onChunk: (pcm, filler) => {
            const at = Math.round(performance.now() - t0);
            firstAudio ??= at;
            if (filler) fillerMs ??= at;
            else firstByte ??= at;
            if (!t.cancelled) ws.send(pcm);
          },
          onError: (e) => {
            // 상태 코드와 종류만 남긴다(본문·키 없음).
            ttsCause = e instanceof TtsError ? `http_${e.status}` : e.name === "TimeoutError" ? "timeout" : "network";
            observer.error("tts.failed", ttsCause);
          },
        })
      : null;
    if (!pipeline) start("none");

    const llmAbort = new AbortController();
    t.abort.signal.addEventListener("abort", () => llmAbort.abort(), { once: true });
    const spoken: string[] = [];
    let firstPieceMs: number | null = null;
    let firstPieceChars: number | null = null;
    const say = (piece: string) => {
      if (firstPieceMs === null) {
        firstPieceMs = Math.round(performance.now() - t0);
        firstPieceChars = piece.length;
      }
      const text = spoken.length ? ` ${piece}` : piece;
      spoken.push(piece);
      if (started) emit({ type: "reply.delta", turnId: t.id, text });
      else held.push(text);
      pipeline?.add(piece);
    };
    /** 문장 수 상한(주행 중 2, 정차 중 4): LLM 답에만 건다. 상한째 문장이 끝나면 capped=true 로 스트림을 끊고 말한 만큼만 남긴다. */
    const cap = plan.llm ? new SentenceCap(plan.driving ? DRIVING_MAX_SENTENCES : PARKED_MAX_SENTENCES) : null;
    let capped = false;
    let sawCant = false;
    /** 조각마다 출력 필터. unsafe 면 true(나머지 출력을 버리고 화제 전환 문장으로 끝낸다). */
    const feed = (pieces: string[]): boolean => {
      for (const p of pieces) {
        if (capped) break;
        // 출력 필터는 문장 단위로 먼저 걸러 내고, 살아남은 문장만 상한에 센다(걸러진 문장이 상한을 잡아먹지 않게).
        const v = checkOutput(p, plan.driving, plan.userText);
        if (v === "unsafe") return true;
        const kept = v === "ok" ? [p] : splitSentences(p).filter((s) => {
          const sv = checkOutput(s, plan.driving, plan.userText);
          if (sv === "cant") sawCant = true;
          return sv === "ok";
        });
        if (v === "cant") sawCant = true;
        for (const s of kept) {
          const r = cap ? cap.take(s) : { text: s, done: false };
          if (r.text) say(r.text);
          if (r.done) {
            capped = true;
            break;
          }
        }
      }
      return false;
    };

    const splitter = new SentenceSplitter(FIRST_PIECE_OPTS);
    let first: number | null = null;
    let firstByte: number | null = null;
    const meta: { model?: string } = {};
    // 첫 토큰이 늦으면 미리 만들어 둔 짧은 채움말을 한 번만 들려준다. 캐시에 있을 때만(공급사를 새로 부르지 않는다), 사용자 말에 답하는 턴만.
    const fillerLine = pick(L.thinking, plan.speech);
    const fillerTimer =
      pipeline && plan.llm && !t.proactive && tts?.cached?.(fillerLine)
        ? setTimeout(() => {
            if (first === null && !t.cancelled && !llmAbort.signal.aborted) pipeline.add(fillerLine, true);
          }, fillerAfter)
        : undefined;
    // 모델이 첫 토큰 뒤에 멈추거나 끝없이 이어져도 턴을 열어 두지 않는다: 전체 기한이 지나면 스트림을 끊고 error 프레임으로 끝낸다.
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      llmAbort.abort();
    }, llmDeadline);
    try {
      let src: AsyncIterable<string>;
      if (plan.llm) {
        let s: AsyncIterable<string> = llmText(plan.llm.system, plan.llm.userText, plan.llm.maxTokens, llmAbort.signal, meta);
        if (plan.llm.fallback !== undefined) s = noneGuard(s, plan.llm.fallback, proactiveFirstMs, () => llmAbort.abort());
        src = s;
      } else {
        src = (async function* () {
          yield plan.text ?? "";
        })();
      }
      let unsafe = false;
      const check = () => {
        if (timedOut) throw new Error("llm deadline exceeded");
      };
      for await (const d of src) {
        check();
        if (t.cancelled) return;
        first ??= Math.round(performance.now() - t0);
        if (feed(splitter.push(d))) {
          unsafe = true;
          llmAbort.abort();
          break;
        }
        if (capped) {
          observer.event("talk.capped", { driving: Number(plan.driving) });
          llmAbort.abort();
          break;
        }
      }
      check();
      if (!unsafe) unsafe = feed(splitter.flush());
      if (unsafe || spoken.length === 0) {
        observer.event("talk.output_filtered", { unsafe: Number(unsafe), cant: Number(sawCant) });
        say(sawCant && !unsafe ? pick(L.cantDo, plan.speech) : redirectLine(plan.speech));
      }
      pipeline?.finish();
      await pipeline?.done;
      if (t.cancelled) return;
      if (!started) start("none");
      const totalMs = Math.round(performance.now() - t0);
      const full = spoken.join(" ");
      emit({ type: "reply.end", turnId: t.id, text: full, firstTokenMs: first, totalMs });
      observer.event("talk.turn", { firstTokenMs: first ?? -1, totalMs, chars: full.length, model: meta.model ?? cfg.model, proactive: Number(t.proactive === true) });
      observer.turn({ llmFirstTokenMs: plan.llm ? first : null, firstTtsByteMs: firstByte, firstAudioMs: firstAudio, fillerMs, firstPieceMs, firstPieceChars, totalMs, model: plan.llm ? (meta.model ?? cfg.model) : "fixed" });
      c.recent.push({ u: plan.userText, a: full });
      if (c.recent.length > RECENT_TURNS) c.recent.shift();
      c.quietUntil = clock.now() + QUIET_AFTER_REPLY_MS;
      if (plan.extractFrom) void extractMemory(ws.data.installId, plan.extractFrom);
    } catch (e) {
      if (t.cancelled) return;
      t.abort.abort();
      pipeline?.finish();
      observer.error("talk.llm_failed", String((e as Error).message));
      send(ws, { type: "error", code: "llm_failed", turnId: t.id, message: String((e as Error).message).slice(0, 300) });
    } finally {
      clearTimeout(fillerTimer);
      clearTimeout(deadlineTimer);
      if (ws.data.turn === t) ws.data.turn = undefined;
    }
  }

  const fixed = (text: string, speech: SpeechStyle, userText: string, driving: boolean): Plan => ({ text, driving, speech, userText });

  function setSettings(installId: string, patch: Partial<Settings>): Settings {
    const next = store.patchSettings(installId, patch);
    hub.pushSettings(installId, next);
    return next;
  }

  /** 첫 만남(F2) 질문 한 줄. */
  const meetQuestion = (stage: number, s: Settings): string => {
    const line = stage === 1 ? L.askSpeech : stage === 2 ? L.askNickname : L.askChat;
    return pick(line, s.speech);
  };

  /** 사용자 말 한 턴을 무엇으로 답할지 정한다. 말로 하는 설정·지우기·첫 만남·안전 필터가 LLM보다 먼저다. */
  function planUserTurn(ws: Ws, t: Turn): Plan {
    const d = ws.data;
    const c = conn(d);
    const s = store.getSettings(d.installId);
    const ctx = { ...c.ctx, ...t.ctx };
    // 시나리오 2: 방금 "들를래?"를 물었고 이 답이 "이따가 할래"면 미뤄 둔다. 어느 쪽이든 질문은 이 답 한 번으로 끝난다.
    const asked = c.pro.rangeAsk;
    c.pro.rangeAsk = null;
    const parked = isParked(ctx);
    const driving = !parked;
    const text = t.text.trim();

    if (asked && isPostpone(text) && !checkInput(text, s.speech)) {
      store.patchTalkState(d.installId, { pendingStop: asked });
      observer.event("talk.stop_postponed", { kind: asked });
      return fixed(pick(L.postponeAck, s.speech), s.speech, text, driving);
    }
    const refusal = checkInput(text, s.speech);
    if (refusal) {
      observer.event("talk.safety_refused", { kind: refusal.kind });
      return fixed(refusal.line, s.speech, text, driving);
    }

    // F2 첫 만남: 어투 → 호칭 → 수다 정도. 정차 중에만 답으로 받는다.
    const st = store.getTalkState(d.installId);
    if (parked && st.meetStage >= 1 && st.meetStage <= 3) {
      if (st.meetStage === 1) {
        const sp = answerSpeech(text) ?? s.speech;
        const next = setSettings(d.installId, { speech: sp });
        store.patchTalkState(d.installId, { meetStage: 2 });
        return fixed(pick(L.askNickname, next.speech), next.speech, text, driving);
      }
      if (st.meetStage === 2) {
        const nick = answerNickname(text);
        const next = setSettings(d.installId, { nickname: nick ?? null });
        store.patchTalkState(d.installId, { meetStage: 3 });
        return fixed(withName(pick(L.askChat, next.speech), next.nickname, next.speech), next.speech, text, driving);
      }
      const lvl = answerChat(text) ?? "normal";
      const next = setSettings(d.installId, { proactive: lvl });
      store.patchTalkState(d.installId, { meetStage: 4 });
      return fixed(withName(pick(L.meetDone, next.speech), next.nickname, next.speech), next.speech, text, driving);
    }

    // F12 말로 지우기
    const forget = parseForget(text);
    if (forget) {
      if (!parked) return fixed(pick(L.forgetDriving, s.speech), s.speech, text, driving);
      if (forget.kind === "all") return fixed(pick(L.forgetAll, s.speech), s.speech, text, driving);
      const items = store.listMemory(d.installId, 200);
      const target = forget.kind === "it" ? items.find((m) => m.id === c.lastMemoryId) ?? null : bestMatch(forget.topic, items);
      if (!target) return fixed(pick(items.length ? L.forgetUnknown : L.forgetEmpty, s.speech), s.speech, text, driving);
      store.deleteMemory(d.installId, target.id);
      if (c.lastMemoryId === target.id) c.lastMemoryId = undefined;
      observer.event("memory.deleted_by_voice", {});
      return fixed(forgetDone(snippet(target.text), s.speech), s.speech, text, driving);
    }

    // F11 어투·호칭 바꾸기
    const sp = parseSpeechChange(text);
    if (sp) {
      const next = setSettings(d.installId, { speech: sp });
      return fixed(pick(sp === "jondaetmal" ? L.speechJondaetmal : L.speechBanmal, next.speech), next.speech, text, driving);
    }
    const nickReq = parseNicknameRequest(text);
    if (nickReq) {
      const next = setSettings(d.installId, { nickname: nickReq });
      return fixed(nicknameSet(nickReq, next.speech), next.speech, text, driving);
    }

    // 일반 대화: 기억을 떠올려 프롬프트에 넣는다.
    const memories = store.memoryAllowed(d.installId) ? recall(store.listMemory(d.installId, 40), text, 4) : [];
    c.lastMemoryId = memories[0]?.id;
    const system = buildSystem({ speech: s.speech, nickname: s.nickname, driving, ctx, memories, recent: c.recent });
    const userTexts = [...c.recent.map((r) => r.u).filter(Boolean).slice(-2), text];
    return { llm: { system, userText: text, maxTokens: cfg.maxTokens }, extractFrom: userTexts, driving, speech: s.speech, userText: text };
  }

  async function runUser(ws: Ws, t: Turn): Promise<void> {
    // AC-4.9-05: no record + external_ai consent (never given, or withdrawn while connected) -> nothing goes to the LLM or TTS.
    if (!store.talkAllowed(ws.data.installId)) {
      ws.data.turn = undefined;
      observer.reject("talk.consent_required");
      return fail(ws, "consent_required", t.id);
    }
    if (opts) {
      try {
        opts.limiter.hit(`turn:${ws.data.id}`, opts.guard.turnsPerMin, 60_000);
        opts.limiter.hit("turn-day", opts.guard.turnsPerDay, 86_400_000);
      } catch {
        observer.reject("talk.rate_limited");
        return fail(ws, "rate_limited", t.id);
      }
    }
    t.running = true;
    let plan: Plan;
    try {
      plan = planUserTurn(ws, t);
    } catch (e) {
      observer.error("talk.plan_failed", String((e as Error).message).slice(0, 200));
      ws.data.turn = undefined;
      return fail(ws, "llm_failed", t.id);
    }
    if (plan.llm && !cfg.apiKey) {
      ws.data.turn = undefined;
      return fail(ws, "no_key", t.id);
    }
    await deliver(ws, t, plan);
  }

  // ---------------- 먼저 말 걸기 ----------------

  function startProactive(ws: Ws, reason: Reason, plan: Plan): boolean {
    const d = ws.data;
    const c = conn(d);
    if (d.turn || clock.now() < c.quietUntil) return false;
    if (!store.talkAllowed(d.installId)) return false;
    if (plan.llm && !cfg.apiKey) return false;
    const t: Turn = { id: `p-${crypto.randomUUID().slice(0, 12)}`, trigger: "listen_after_proactive", text: "", ctx: { ...c.ctx }, abort: new AbortController(), cancelled: false, running: true, proactive: true };
    d.turn = t;
    send(ws, { type: "proactive", id: t.id, reason });
    observer.event("talk.proactive", { reason });
    void deliver(ws, t, plan);
    return true;
  }

  const clearArrival = (c: Conn) => {
    if (c.arrival) clock.clearTimeout(c.arrival);
    c.arrival = undefined;
  };

  const clearFirstStopRetry = (c: Conn) => {
    if (c.firstStopRetry) clock.clearTimeout(c.firstStopRetry);
    c.firstStopRetry = undefined;
  };

  /** 기억을 담은 먼저 말 계획. 최근(3일 이내) 기억만 쓰고, 없으면 바로 고정 문장. 모델이 NONE·실패·느리면 fallback 문장. */
  function memoryPlan(ws: Ws, s: Settings, ctx: Ctx, reason: string, instruction: string, fallback: string): Plan {
    const d = ws.data;
    const c = conn(d);
    const memories = store.memoryAllowed(d.installId) && c.pro.memoryRecalls < MAX_MEMORY_RECALLS ? recentForProactive(store.listMemory(d.installId, 12), clock.now()) : [];
    if (!memories.length) return fixed(fallback, s.speech, "", false);
    c.pro.memoryRecalls++;
    c.lastMemoryId = memories[0]?.id;
    const system = buildSystem({ speech: s.speech, nickname: s.nickname, driving: false, ctx, memories, recent: c.recent, proactive: { reason, instruction } });
    return { llm: { system, userText: "(먼저 말을 건다)", maxTokens: PROACTIVE_MAX_TOKENS, fallback }, driving: false, speech: s.speech, userText: "" };
  }

  function arrivalPlan(ws: Ws, s: Settings, ctx: Ctx): Plan {
    const c = conn(ws.data);
    const ev = c.pro.dayEvents;
    const fallback = withName(pick(ev.has("rain") ? L.arriveRain : ev.has("dark") ? L.arriveDark : L.arriveDefault, s.speech), s.nickname, s.speech);
    const instruction =
      '방금 목적지에 도착해 주차(P)했다. [기억] 맨 위 항목이 "오늘 말함"이고 면접·발표·약속·시험·병원처럼 오늘 이어서 챙길 일이면, 그 일을 잘 하고 오라는 도착 인사를 한 문장으로 한다(예: "도착했네! 오늘 면접 잘 보고 와, 끝나고 어땠는지 알려 줘!"). 어제 이전 것이거나 챙길 만한 게 없으면 정확히 NONE 한 단어만 쓴다. 기억에 없는 장소·시간은 말하지 않는다.';
    return memoryPlan(ws, s, ctx, "arrival", instruction, fallback);
  }

  function greetingPlan(ws: Ws, s: Settings, ctx: Ctx): Plan {
    const fallback = withName(pick(L.greetDefault, s.speech), s.nickname, s.speech);
    const instruction =
      '오늘 처음 탔다. [기억] 중 "어제 말함"(또는 며칠 전)이면서 결과를 물어볼 만한 일(면접, 발표, 약속, 시험, 병원 등)이 있으면 그 결과를 묻는 첫 인사를 한 문장으로 한다(예: "어제 면접 어땠어?"). 오늘 말한 것이거나 물을 만한 게 없으면 정확히 NONE 한 단어만 쓴다. 기억에 없는 내용은 지어내지 않는다.';
    return memoryPlan(ws, s, ctx, "greeting", instruction, fallback);
  }

  function eventLine(reason: EventReason, s: Settings, ctx: Ctx): string {
    switch (reason) {
      case "wiper": return pick(L.wiper, s.speech);
      case "headlight": return pick(L.headlight, s.speech);
      case "door": return pick(L.door, s.speech);
      case "range": {
        const k = fuelKind(ctx.fuelType);
        if (typeof ctx.destKm === "number" && ctx.destKm > 0 && typeof ctx.rangeKm === "number") return rangeDestLine(k, Math.round(ctx.destKm), Math.round(ctx.rangeKm), s.speech);
        return pick(k === "ev" ? L.rangeEv : k === "lpg" ? L.rangeLpg : L.rangeIce, s.speech);
      }
    }
  }

  /**
   * 미뤄 둔 들르기(시나리오 2)를 다음 정차에 한 번 챙긴다. 내비 안내 중이면(D-14) 건드리지 않고 남겨 둔다.
   * 그사이 주행가능거리가 넉넉해졌으면(충전·주유 했다) 말없이 지운다. 말하면 true.
   */
  function remindStop(ws: Ws, s: Settings, cur: Ctx): boolean {
    const id = ws.data.installId;
    const kind = store.getTalkState(id).pendingStop;
    if (!kind || cur.naviGuiding === true || intervalMs(s.proactive) === null) return false;
    if (typeof cur.rangeKm === "number" && cur.rangeKm >= RANGE_REFILLED_KM) {
      store.patchTalkState(id, { pendingStop: null });
      return false;
    }
    if (!startProactive(ws, "reminder", fixed(pick(kind === "ev" ? L.remindEv : kind === "lpg" ? L.remindLpg : L.remindIce, s.speech), s.speech, "", false))) return false;
    store.patchTalkState(id, { pendingStop: null });
    observer.event("talk.stop_reminded", { kind });
    return true;
  }

  /** 연결 후 첫 정차(인사·첫 만남). 끝났으면(말을 걸었거나 걸 일이 없으면) true, 이미 말하는 중이라 거절됐으면 false 라 다시 시도한다. */
  function firstStop(ws: Ws, s: Settings, cur: Ctx, now: number): boolean {
    if (intervalMs(s.proactive) === null || cur.naviGuiding === true) return true;
    const st = store.getTalkState(ws.data.installId);
    if (st.meetStage === 0) {
      if (!startProactive(ws, "meet", fixed(meetQuestion(1, s), s.speech, "", false))) return false;
      store.patchTalkState(ws.data.installId, { meetStage: 1, lastGreetingDay: kstDay(now) });
      return true;
    }
    // 질문을 받고도 답이 없었던 첫 만남은 기본값으로 끝낸다("무응답이면 기본값").
    if (st.meetStage < 4) store.patchTalkState(ws.data.installId, { meetStage: 4 });
    const today = kstDay(now);
    if (st.lastGreetingDay === today) {
      remindStop(ws, s, cur);
      return true;
    }
    if (!startProactive(ws, "greeting", greetingPlan(ws, s, cur))) return false;
    store.patchTalkState(ws.data.installId, { lastGreetingDay: today });
    return true;
  }

  /**
   * 이 연결의 첫 정차 처리. 연결 직후 첫 ctx 가 기어 P 였고(firstStopArmed), 아직 안 했고, 달린 적 없고, 동의가 있으면 한 번 한다.
   * 동의가 ctx 보다 먼저 오든 나중에 오든 동의 변경·ctx 프레임·재시도 타이머마다 다시 본다(결정적).
   */
  function tryFirstStop(ws: Ws): void {
    const c = conn(ws.data);
    if (!c.firstStopArmed || c.pro.greetChecked || c.pro.drove || c.ctx.gear !== "P" || !store.talkAllowed(ws.data.installId)) return;
    if (firstStop(ws, store.getSettings(ws.data.installId), c.ctx, clock.now())) {
      c.pro.greetChecked = true;
      return;
    }
    // 말하는 중·조용한 시간 때문에 거절됐다: 차가 ctx 를 다시 보내지 않아도 곧 다시 시도한다.
    if (c.firstStopRetry === undefined) {
      c.firstStopRetry = clock.setTimeout(() => {
        c.firstStopRetry = undefined;
        tryFirstStop(ws);
      }, FIRST_STOP_RETRY_MS);
    }
  }

  /** 서버가 "지금 말을 걸까"를 정하는 곳. 차 앱이 보낸 ctx 스냅샷이 바뀔 때마다 부른다. */
  function onVehicle(ws: Ws, prev: Ctx, cur: Ctx): void {
    const d = ws.data;
    const c = conn(d);
    const now = clock.now();
    const pro = c.pro;
    const baseline = !c.seen && Object.keys(prev).length === 0;
    c.seen = true;

    const moving = cur.gear === "D" || cur.gear === "R" || (typeof cur.speedKmh === "number" && cur.speedKmh > 0);
    if (moving) {
      pro.drove = true;
      clearArrival(c);
    }
    // 오늘 있었던 일(도착 인사 ②)은 말했든 안 했든 센다.
    if (!baseline) {
      if (wiperOn(cur.wiper) && !wiperOn(prev.wiper)) pro.dayEvents.add("rain");
      if (cur.headlight === true && prev.headlight !== true && isNight(now)) pro.dayEvents.add("dark");
    }

    const s = store.getSettings(d.installId);
    const gap = intervalMs(s.proactive);
    const gearP = cur.gear === "P";
    const navi = cur.naviGuiding === true;

    // 기어 P로 바뀜: 첫 정차(인사·첫 만남) 또는 도착(3초 뒤 한마디)
    if (gearP && prev.gear !== "P") {
      // 첫 정차: 연결 뒤 처음 받은 ctx이거나, 기어를 아직 몰랐다가(Pleos 기어 리스너가 늦게 답함) 처음 알게 된 P.
      if ((baseline || prev.gear === undefined) && !pro.greetChecked && !pro.drove) {
        c.firstStopArmed = true;
        tryFirstStop(ws);
        return;
      }
      if (pro.drove) {
        clearArrival(c);
        c.arrival = clock.setTimeout(() => {
          c.arrival = undefined;
          const cur2 = c.ctx;
          if (cur2.gear !== "P" || cur2.naviGuiding === true || !pro.drove) return;
          const s2 = store.getSettings(d.installId);
          if (intervalMs(s2.proactive) !== null && !remindStop(ws, s2, cur2)) startProactive(ws, "arrival", arrivalPlan(ws, s2, cur2));
          // 새 주행을 위해 한 주행 단위 상태를 비운다. 말을 못 걸었더라도(내비·재생 중) 낡은 도착을 다음에 말하지 않는다.
          pro.drove = false;
          pro.fired.clear();
          pro.memoryRecalls = 0;
          pro.dayEvents.clear();
        }, arrivalDelay);
      }
      return;
    }

    // 첫 정차가 아직이면(동의·진행 중 턴 때문에 미뤄졌으면) 기어 P 인 ctx 마다 다시 본다.
    if (gearP) tryFirstStop(ws);

    // 이벤트 한마디(와이퍼·거리·라이트·도어): 끄기·내비·간격·같은 주행 1회·이유별 쿨다운을 지킨다.
    if (baseline || gap === null) return; // 내비 중 차단은 eventAllowed 가 한다(시나리오 2 정차 예외만 통과)
    // 첫 만남 질문이 열려 있는데 이벤트가 먼저 오면 질문은 접고 기본값으로 간다(이벤트가 우선).
    const stage = store.getTalkState(d.installId).meetStage;
    for (const reason of detectEvents(prev, cur, now)) {
      if (!eventAllowed(reason, s.proactive, cur, pro, now)) continue;
      if (startProactive(ws, reason, fixed(eventLine(reason, s, cur), s.speech, "", !isParked(cur)))) {
        if (reason === "range") pro.rangeAsk = fuelKind(cur.fuelType);
        pro.fired.add(reason);
        pro.reasonAt[reason] = now;
        pro.lastEventAt = now;
        if (stage >= 1 && stage <= 3) store.patchTalkState(d.installId, { meetStage: 4 });
      }
    }
  }

  hub.onConsent = (ws, withdrawn) => {
    if (withdrawn) revokeTalk(ws);
    else tryFirstStop(ws);
  };

  return {
    open(ws: Ws) {
      hub.add(ws);
      observer.event("talk.open", { conn: ws.data.id.slice(0, 8) });
    },
    close(ws: Ws) {
      hub.remove(ws);
      if (ws.data.conn) {
        clearArrival(ws.data.conn);
        clearFirstStopRetry(ws.data.conn);
      }
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
          opts?.tts?.warm?.();
          clearArrival(conn(d));
          d.turn = { id: f.turnId, trigger: f.trigger, text: "", ctx: {}, abort: new AbortController(), cancelled: false, running: false };
          return;
        case "ctx": {
          const c = conn(d);
          const t = f.turnId === undefined ? d.turn : d.turn?.id === f.turnId ? d.turn : undefined;
          if (f.turnId !== undefined && !t) return fail(ws, "turn_unknown", f.turnId);
          if (t) Object.assign(t.ctx, f.ctx);
          const prev = c.ctx;
          c.ctx = { ...prev, ...f.ctx };
          if (f.turnId === undefined) onVehicle(ws, prev, c.ctx);
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
          return runUser(ws, t);
        }
      }
    },
  };
}

