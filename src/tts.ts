import { readFileSync } from "node:fs";
import { loadSecrets } from "./llm/secrets";
import type { Observability } from "./observe";

/** 서버 TTS (developer.md §6.5b, hey_voice.json). 오디오는 메모리에서 바로 흘려보내며 디스크에 쓰지 않는다. */
export const PCM_FORMAT = { format: "pcm_s16le", sampleRate: 24000, channels: 1 } as const;

export const BREEZE_BASE = "https://api.breeze.blue";
const VOICE_ID = "voc_vwuzwn929yym";
const MODEL_ID = "breeze-tts-2-multilingual";
const LANGUAGE = "ko";
const MAX_CONCURRENT = 2;

/** 고래 목소리 속도(기획 whale_voice.json): 1.5배, 15자 안팎의 짧은 조각은 끝 음절이 묻혀 1.4배. */
export const WHALE_SPEED = 1.5;
export const WHALE_SPEED_SHORT = 1.4;
export const WHALE_SHORT_CHARS = 15;
export const whaleSpeed = (text: string): number => ([...text.trim()].length <= WHALE_SHORT_CHARS ? WHALE_SPEED_SHORT : WHALE_SPEED);

export interface TtsConfig {
  provider: "breeze" | "fake" | "off";
  apiKey: string | undefined;
  voiceId: string;
  /** 고래(온보딩 안내자)의 Breeze 목소리. 비밀 파일/환경변수 ONBOARDING_VOICE_ID 에서만 읽고, 없으면 헤이리 목소리로 대신한다(한 번 로그). 값은 로그에 남기지 않는다. */
  onboardingVoiceId?: string | undefined;
  /** 목소리를 잃었을 때 복제를 다시 할 원본 샘플 경로(없으면 복구 시도 안 함) */
  sampleFile: string | undefined;
}

export class TtsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** synth 의 보조 옵션. background 는 미리 만들어 두기 같은 배경 작업: 실제 턴이 쓸 자리를 남겨 둔다. */
export interface SynthOpts {
  background?: boolean;
  /** "whale" 이면 고래 목소리(없으면 헤이리 목소리). */
  voice?: "whale";
}
/** 한 문장의 PCM 청크 스트림. 취소하면 signal 로 끊는다. */
export interface TtsProvider {
  synth(text: string, signal: AbortSignal, opts?: SynthOpts): Promise<AsyncIterable<Uint8Array>>;
  /** 곧 synth 가 불릴 것을 알리는 신호. 연결(TCP+TLS)을 미리 열어 둔다. 실패해도 조용히 넘어간다. */
  warm?(): void;
  /** 이 문장의 오디오가 메모리에 있어 공급사를 거치지 않고 바로 나가는가. */
  cached?(text: string): boolean;
}

/** COMPANION_TTS_PROVIDER = breeze(기본, 키 있을 때) | fake | off. 키 없는 breeze 는 off 로 본다. */
export function loadTtsConfig(env: Record<string, string | undefined> = process.env): TtsConfig {
  const secrets = loadSecrets();
  const pick = (k: string) => env[k] || secrets[k] || undefined;
  const apiKey = pick("BREEZE_API_KEY");
  const asked = (env.COMPANION_TTS_PROVIDER ?? "breeze").toLowerCase();
  const provider = asked === "fake" ? "fake" : asked === "off" || !apiKey ? "off" : "breeze";
  return { provider, apiKey, voiceId: pick("BREEZE_VOICE_ID") ?? VOICE_ID, onboardingVoiceId: pick("ONBOARDING_VOICE_ID"), sampleFile: pick("COMPANION_VOICE_SAMPLE") };
}

/** 시험·CI 용: 문장 길이에 비례한 가짜 PCM 을 몇 조각으로 돌려준다. */
export class FakeTts implements TtsProvider {
  calls: string[] = [];
  active = 0;
  maxActive = 0;
  warmed = 0;
  /** 부른 목소리(시험에서 고래 목소리가 갔는지 본다). */
  voices: (SynthOpts["voice"] | undefined)[] = [];
  constructor(private readonly delayMs = 0) {}

  warm(): void {
    this.warmed++;
  }

  async synth(text: string, signal: AbortSignal, opts?: SynthOpts): Promise<AsyncIterable<Uint8Array>> {
    this.calls.push(text);
    this.voices.push(opts?.voice);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const delay = this.delayMs;
    const self = this;
    return (async function* () {
      try {
        for (let i = 0; i < 3; i++) {
          if (delay) await Bun.sleep(delay);
          if (signal.aborted) return;
          yield new Uint8Array(480).fill(i + 1);
        }
      } finally {
        self.active--;
      }
    })();
  }
}

/** BreezeBlue 스트리밍 TTS. 404(목소리 없음)면 원본 샘플로 복제를 한 번만 다시 만든다. */
export class BreezeTts implements TtsProvider {
  private voiceId: string;
  private recreated = false;

  constructor(
    private readonly cfg: TtsConfig,
    private readonly observer: Observability,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.voiceId = cfg.voiceId;
  }

  private async post(text: string, signal: AbortSignal, voice?: "whale"): Promise<Response> {
    const voiceId = voice === "whale" && this.cfg.onboardingVoiceId ? this.cfg.onboardingVoiceId : this.voiceId;
    return this.fetchImpl(`${BREEZE_BASE}/v1/text-to-speech/${voiceId}/stream?output_format=pcm`, {
      method: "POST",
      headers: { "xi-api-key": this.cfg.apiKey ?? "", "content-type": "application/json" },
      // hey_voice.json: instructions 는 넣지 않는다(원본과 유사도가 떨어짐)
      body: JSON.stringify({ text, model_id: MODEL_ID, language_code: LANGUAGE, voice_settings: voice === "whale" ? { use_speaker_boost: true, speed: whaleSpeed(text) } : { use_speaker_boost: true } }),
      signal,
    });
  }

  /**
   * 턴이 시작될 때(LLM 첫 토큰을 기다리는 1.5초 동안) 공급사 연결을 데워 둔다. 크레딧을 쓰지 않는 GET 이다.
   * fetch.preconnect 는 이 Bun(1.4.x)에서 "Invalid port" 로 던져 한 번도 동작하지 않았다(예외를 삼켜서 몰랐다).
   * 데운 연결은 첫 합성 요청이 그대로 쓴다(2026-11-14 측정: 첫 TTS 요청 1.0~1.6초 → 연결 재사용 0.55~0.7초).
   */
  warm(): void {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    this.fetchImpl(`${BREEZE_BASE}/v1/models`, { headers: { "xi-api-key": this.cfg.apiKey ?? "" }, signal: ctl.signal })
      .then((r) => r.arrayBuffer())
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }

  async synth(text: string, signal: AbortSignal, opts?: SynthOpts): Promise<AsyncIterable<Uint8Array>> {
    let res = await this.post(text, signal, opts?.voice);
    if (res.status === 404 && !this.recreated && this.cfg.sampleFile && !(opts?.voice === "whale" && this.cfg.onboardingVoiceId)) {
      this.recreated = true;
      this.voiceId = await this.recreateVoice(signal);
      res = await this.post(text, signal, opts?.voice);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new TtsError(res.status, `breeze HTTP ${res.status}`);
    }
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }

  /** recreate_if_lost: voice-previews/clone → save. 새 voice_id 는 로그에 한 번 남긴다(비밀 아님). */
  private async recreateVoice(signal: AbortSignal): Promise<string> {
    const headers = { "xi-api-key": this.cfg.apiKey ?? "" };
    const form = new FormData();
    form.append("files", new Blob([readFileSync(this.cfg.sampleFile as string)], { type: "audio/mpeg" }), "breeze_neutral_original.mp3");
    const clone = await this.fetchImpl(`${BREEZE_BASE}/v1/voice-previews/clone`, { method: "POST", headers, body: form, signal });
    if (!clone.ok) throw new TtsError(clone.status, `breeze clone HTTP ${clone.status}`);
    const cj = (await clone.json()) as { generated_voice_id?: string };
    if (!cj.generated_voice_id) throw new TtsError(502, "breeze clone: no generated_voice_id");
    const save = await this.fetchImpl(`${BREEZE_BASE}/v1/voice-previews/${cj.generated_voice_id}/save`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ voice_name: "HEY 중성 (원본 복제)", language_code: LANGUAGE }),
      signal,
    });
    if (!save.ok) throw new TtsError(save.status, `breeze save HTTP ${save.status}`);
    const sj = (await save.json()) as { voice_id?: string };
    if (!sj.voice_id) throw new TtsError(502, "breeze save: no voice_id");
    this.observer.event("tts.voice_recreated", { voiceId: sj.voice_id });
    return sj.voice_id;
  }
}

/**
 * 제공자 조립: 캐시(고정 문장) → 동시 생성 한도 → 공급사. 가짜 TTS 도 같은 길을 지난다(시험이 실제 경로를 탄다).
 */
export function makeTts(cfg: TtsConfig, observer: Observability, fetchImpl?: typeof fetch): PhraseCache | null {
  if (cfg.provider !== "fake" && cfg.provider !== "breeze") return null;
  const base = cfg.provider === "fake" ? new FakeTts() : new BreezeTts(cfg, observer, fetchImpl);
  if (!cfg.onboardingVoiceId) observer.event("tts.whale_voice_fallback", { reason: "ONBOARDING_VOICE_ID unset, whale speaks with the heyri voice" });
  return new PhraseCache(new GatedTts(base, new Semaphore(), observer), cfg.voiceId);
}

/** 공급사 전체 동시 생성 수를 제한한다(Starter: 최대 2). */
export class Semaphore {
  private free: number;
  private readonly capacity: number;
  private readonly queue: (() => void)[] = [];
  private readonly idle: (() => void)[] = [];
  constructor(n = MAX_CONCURRENT) {
    this.free = n;
    this.capacity = n;
  }
  async acquire(signal: AbortSignal): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onAbort = () => {
      const i = this.queue.indexOf(go);
      if (i >= 0) this.queue.splice(i, 1);
      reject(new Error("aborted"));
    };
    const go = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.queue.push(go);
    return promise;
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
    const waiting = this.idle.splice(0);
    for (const wake of waiting) wake();
  }

  /**
   * 배경 작업용: 줄 서 있는 실제 요청이 없고, 잡은 뒤에도 자리가 reserve 개 남을 때만 잡는다(실제 턴이 항상 자리를 얻도록).
   * 한도가 reserve 이하이면(자리가 하나뿐) 아무도 안 쓰고 있을 때만 잡는다.
   */
  async acquireIdle(signal: AbortSignal, reserve = 1): Promise<void> {
    const need = Math.min(reserve + 1, this.capacity);
    while (this.free < need || this.queue.length > 0) {
      if (signal.aborted) throw new Error("aborted");
      const { promise, resolve } = Promise.withResolvers<void>();
      this.idle.push(resolve);
      const wake = () => resolve();
      signal.addEventListener("abort", wake, { once: true });
      await promise;
      signal.removeEventListener("abort", wake);
    }
    this.free--;
  }
}

/**
 * 공급사 동시 생성 한도(Starter 2)를 서버 안에서 지킨다: 자리가 없으면 줄을 서고(429를 받지 않는다), 기다린 시간을 로그로 남긴다.
 * 자리는 스트림이 끝나거나 취소될 때 돌려준다.
 */
export class GatedTts implements TtsProvider {
  constructor(
    private readonly inner: TtsProvider,
    private readonly sem: Semaphore,
    private readonly observer: Observability,
  ) {}

  cached(text: string): boolean {
    return this.inner.cached?.(text) ?? false;
  }

  warm(): void {
    this.inner.warm?.();
  }

  async synth(text: string, signal: AbortSignal, opts?: SynthOpts): Promise<AsyncIterable<Uint8Array>> {
    const t0 = performance.now();
    if (opts?.background) await this.sem.acquireIdle(signal);
    else await this.sem.acquire(signal);
    const waited = Math.round(performance.now() - t0);
    if (waited >= 1 && !opts?.background) this.observer.event("tts.queue_wait", { ms: waited });
    let body: AsyncIterable<Uint8Array>;
    try {
      body = await this.inner.synth(text, signal, opts?.voice ? { voice: opts.voice } : undefined);
    } catch (e) {
      this.sem.release();
      throw e;
    }
    const sem = this.sem;
    return (async function* () {
      try {
        yield* body;
      } finally {
        sem.release();
      }
    })();
  }
}

/** 첫 조각을 일찍 자르는 규칙. 답 문장과 미리 만들어 두는 고정 문장이 같은 조각으로 나뉘어야 캐시가 맞는다. */
export const FIRST_PIECE_OPTS = { firstClauseMin: 6, firstWordsMin: 10 } as const;

const CACHE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 고정 문장의 PCM 을 메모리에만 둔다(디스크에 쓰지 않는다). 키는 목소리+문장, 가장 오래 안 쓴 것부터 버려 50MB 를 넘지 않는다.
 * prime 에 넣은 문장만 담는다(LLM 이 만든 문장은 담지 않는다). 적중하면 공급사 호출도, 동시 생성 자리도 쓰지 않는다.
 */
export class PhraseCache implements TtsProvider {
  private readonly map = new Map<string, Uint8Array[]>();
  private readonly keep = new Set<string>();
  private bytes = 0;

  constructor(
    private readonly inner: TtsProvider,
    private readonly voiceKey: string,
    private readonly maxBytes = CACHE_MAX_BYTES,
  ) {}

  private key(text: string, voice?: "whale"): string {
    return `${this.voiceKey}${voice ? `:${voice}` : ""}\u0000${text}`;
  }

  get size(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.bytes };
  }

  cached(text: string): boolean {
    return this.map.has(this.key(text));
  }

  warm(): void {
    this.inner.warm?.();
  }

  async synth(text: string, signal: AbortSignal, opts?: SynthOpts): Promise<AsyncIterable<Uint8Array>> {
    const k = this.key(text, opts?.voice);
    const hit = this.map.get(k);
    if (hit) {
      this.map.delete(k);
      this.map.set(k, hit);
      return (async function* () {
        for (const c of hit) {
          if (signal.aborted) return;
          yield c;
        }
      })();
    }
    const body = await this.inner.synth(text, signal, opts);
    if (!this.keep.has(text)) return body;
    const got: Uint8Array[] = [];
    const store = (chunks: Uint8Array[]) => this.store(k, chunks);
    return (async function* () {
      for await (const c of body) {
        got.push(c);
        yield c;
      }
      if (!signal.aborted) store(got);
    })();
  }

  private store(k: string, chunks: Uint8Array[]): void {
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (size === 0 || size > this.maxBytes) return;
    const old = this.map.get(k);
    if (old) this.bytes -= old.reduce((n, c) => n + c.length, 0);
    this.map.delete(k);
    this.map.set(k, chunks);
    this.bytes += size;
    for (const [ok, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(ok);
      this.bytes -= v.reduce((n, c) => n + c.length, 0);
    }
  }

  /** 이 문장들은 처음 말할 때 캐시에 담는다(미리 합성하지는 않는다). 공급사 호출을 늘리지 않고 두 번째부터 즉시 나가게 한다. */
  remember(texts: string[]): void {
    for (const t of texts) this.keep.add(t);
  }

  /**
   * 문장을 하나씩 합성해 담는다. 배경 작업이라 실제 턴이 쓸 자리를 남기고(자리가 둘 다 비었을 때만 하나 쓴다), 연속 2번 실패하면 멈춘다(키·크레딧 문제일 수 있다).
   * 배포마다 도는 일이라 호출 수를 아끼려고 호출하는 쪽이 고른 소수만 넣는다.
   */
  async prime(texts: string[], signal: AbortSignal = new AbortController().signal): Promise<{ done: number; failed: number; entries: number; bytes: number }> {
    const order = [...new Set(texts)];
    this.remember(order);
    let done = 0;
    let failed = 0;
    let streak = 0;
    for (const text of order) {
      if (signal.aborted || streak >= 2) break;
      if (this.cached(text)) continue;
      try {
        for await (const _ of await this.synth(text, signal, { background: true })) void _;
        done++;
        streak = 0;
      } catch {
        failed++;
        streak++;
      }
    }
    return { done, failed, entries: this.map.size, bytes: this.bytes };
  }
}

const MIN_SENTENCE_CHARS = 6;
const END = /[.!?。！？…]+["'”’)\]」』]*(?=\s|$)|\n+/g;

/**
 * LLM 델타를 모아 문장이 끝날 때마다 내보낸다. 너무 짧은 조각은 다음 문장과 합친다.
 * firstClauseMin 을 주면 첫 조각만 쉼표에서도 끊는다(그 글자 수 이상일 때): 첫 소리를 문장 끝까지 기다리지 않으려는 것이다.
 */
export class SentenceSplitter {
  private buf = "";
  private emitted = 0;

  constructor(private readonly opts: { firstClauseMin?: number; firstWordsMin?: number } = {}) {}

  /** 아직 내보내지 않은 글자(경계 검사용). */
  get pending(): string {
    return this.buf;
  }

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let start = 0;
    const min = this.opts.firstClauseMin;
    if (min !== undefined && this.emitted === 0) {
      const comma = /[,，、]/.exec(this.buf);
      if (comma) {
        const end = comma.index + 1;
        const piece = this.buf.slice(0, end).trim();
        if (piece.length >= min && !/[.!?。！？…\n]/.test(piece)) {
          out.push(piece);
          start = end;
        }
      }
    }
    END.lastIndex = start;
    for (let m = END.exec(this.buf); m; m = END.exec(this.buf)) {
      const end = m.index + m[0].length;
      const piece = this.buf.slice(start, end).trim();
      if (piece.length >= MIN_SENTENCE_CHARS) {
        out.push(piece);
        start = end;
      }
    }
    // 쉼표도 문장 끝도 없이 길어지면, 첫 조각만 마지막 띄어쓰기에서 끊는다(첫 소리를 더 앞당긴다).
    const words = this.opts.firstWordsMin;
    if (words !== undefined && this.emitted === 0 && out.length === 0) {
      const cut = this.buf.lastIndexOf(" ");
      if (cut >= words && !/[.!?。！？…\n]/.test(this.buf.slice(0, cut))) {
        out.push(this.buf.slice(0, cut).trim());
        start = cut;
      }
    }
    this.buf = this.buf.slice(start);
    this.emitted += out.length;
    return out;
  }

  /** 남은 글자(끝나는 부호가 없는 마지막 조각) */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

export interface AudioSink {
  /** 정확히 한 번: 첫 오디오 조각이 준비되면 true(조각 전달보다 먼저), 첫 문장이 실패했거나 문장이 없으면 false. */
  onStart(ok: boolean): void;
  /** filler 는 답이 아니라 "음…" 같은 채움 소리의 조각이다. */
  onChunk(pcm: Uint8Array, filler: boolean): void;
  /** 첫 문장 이후의 실패(오디오는 거기서 끊긴다). */
  onError(e: Error): void;
}

interface Job {
  chunks: Uint8Array[];
  done: boolean;
  error: Error | undefined;
  wake: (() => void) | undefined;
  filler: boolean;
  /** 이 조각이 문장 끝(. ! ? … 로 끝남)인지: 다음 조각 앞의 쉼 길이를 정한다. */
  sentenceEnd: boolean;
}

/** 문장 사이 쉼(ms). Breeze 가 조각 앞뒤 무음을 잘라 내 이어 붙이면 붙어 들린다. 방출할 때 끼우고 캐시에는 넣지 않는다. 고래 목소리도 같다(whale_voice.json 의 0.35초). */
export const GAP_AFTER_SENTENCE_MS = 350;
/** 쉼표·띄어쓰기에서 일찍 자른 조각 뒤의 쉼(ms). */
export const GAP_AFTER_CLAUSE_MS = 180;

/** 쉼의 PCM(0 바이트). 길이는 항상 샘플 크기의 배수다. */
export function silencePcm(ms: number): Uint8Array {
  const samples = Math.round((PCM_FORMAT.sampleRate * ms) / 1000);
  return new Uint8Array(samples * 2 * PCM_FORMAT.channels);
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]」』]*\s*$/u;

/**
 * 문장이 완성되는 대로 TTS 를 시작하고, 결과 PCM 을 문장 순서대로 내보낸다. 동시 생성 수 제한은 제공자(GatedTts)가 맡는다.
 * 취소(signal)되면 아무것도 더 내보내지 않는다. 오디오는 메모리에서만 흐른다.
 */
export class AudioPipeline {
  private readonly jobs: Job[] = [];
  private closed = false;
  /** 어떤 문장이든 실패하면 더 이상 TTS 를 요청하지 않는다(크레딧 낭비 방지). */
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  private kick: (() => void) | undefined;
  readonly done: Promise<void>;

  constructor(
    private readonly tts: TtsProvider,
    private readonly signal: AbortSignal,
    private readonly sink: AudioSink,
    /** 이 문장들을 읽을 목소리(기본: 헤이리). */
    private readonly voice?: "whale",
  ) {
    this.done = this.drain();
    // 취소되면 대기 중인 drain 이 깨어나 끝나도록 한다.
    signal.addEventListener("abort", () => this.finish(), { once: true });
  }

  /**
   * 한 턴은 공급사에 동시에 한 요청만 보낸다: 앞 조각의 합성이 끝난 뒤에 다음 조각을 시작한다. 그래야 동시 생성 2자리가 두 턴을 받친다.
   * (조각 1의 오디오가 재생되는 동안 조각 2를 만들어도 늦지 않는다. 캐시된 조각은 바로 끝난다.)
   */
  add(sentence: string, filler = false): void {
    if (this.failed) return;
    const job: Job = { chunks: [], done: false, error: undefined, wake: undefined, filler, sentenceEnd: SENTENCE_END.test(sentence) };
    this.jobs.push(job);
    this.tail = this.tail.then(() => this.generate(job, sentence));
    this.kick?.();
  }

  /** 더 이상 문장이 없다. */
  finish(): void {
    this.closed = true;
    this.kick?.();
  }

  private async generate(job: Job, sentence: string): Promise<void> {
    const notify = () => job.wake?.();
    if (this.failed || this.signal.aborted) {
      job.done = true;
      notify();
      return;
    }
    try {
      for await (const c of await this.tts.synth(sentence, this.signal, this.voice ? { voice: this.voice } : undefined)) {
        if (this.signal.aborted) break;
        job.chunks.push(c);
        notify();
      }
    } catch (e) {
      job.error = e as Error;
      this.failed = true;
    }
    job.done = true;
    notify();
  }

  private async drain(): Promise<void> {
    let started = false;
    /** 마지막으로 소리를 낸 답 조각(채움말 제외). 다음 답 조각 앞에 쉼을 끼울지 정한다. */
    let prevAnswer: Job | undefined;
    for (let i = 0; ; i++) {
      while (i >= this.jobs.length && !this.closed) await this.wait((w) => (this.kick = w));
      if (this.signal.aborted) return;
      const job = this.jobs[i];
      if (!job) break;
      for (let sent = 0; ; ) {
        if (this.signal.aborted) return;
        const c = job.chunks[sent];
        if (c) {
          if (!started) {
            started = true;
            this.sink.onStart(true);
          }
          if (sent === 0 && !job.filler) {
            if (prevAnswer) this.sink.onChunk(silencePcm(prevAnswer.sentenceEnd ? GAP_AFTER_SENTENCE_MS : GAP_AFTER_CLAUSE_MS), false);
            prevAnswer = job;
          }
          this.sink.onChunk(c, job.filler);
          sent++;
        } else if (job.done) {
          break;
        } else {
          await this.wait((w) => (job.wake = w));
        }
      }
      if (job.error) {
        // 첫 문장이 실패해도 원인은 남긴다(그 뒤 onStart(false) 로 자막만 보낸다).
        this.sink.onError(job.error);
        if (!started) break;
        return;
      }
    }
    if (this.signal.aborted) return;
    if (!started) this.sink.onStart(false);
  }

  private async wait(register: (w: () => void) => void): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    register(resolve);
    await promise;
  }
}
