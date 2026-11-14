import { readFileSync } from "node:fs";
import { loadSecrets } from "./llm/secrets";
import type { Observability } from "./observe";

/** 서버 TTS (developer.md §6.5b, hey_voice.json). 오디오는 메모리에서 바로 흘려보내며 디스크에 쓰지 않는다(D-10). */
export const PCM_FORMAT = { format: "pcm_s16le", sampleRate: 24000, channels: 1 } as const;

export const BREEZE_BASE = "https://api.breeze.blue";
const VOICE_ID = "voc_vwuzwn929yym";
const MODEL_ID = "breeze-tts-2-multilingual";
const LANGUAGE = "ko";
const MAX_CONCURRENT = 2;

export interface TtsConfig {
  provider: "breeze" | "fake" | "off";
  apiKey: string | undefined;
  voiceId: string;
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
  return { provider, apiKey, voiceId: pick("BREEZE_VOICE_ID") ?? VOICE_ID, sampleFile: pick("COMPANION_VOICE_SAMPLE") };
}

/** 시험·CI 용: 문장 길이에 비례한 가짜 PCM 을 몇 조각으로 돌려준다. */
export class FakeTts implements TtsProvider {
  calls: string[] = [];
  active = 0;
  maxActive = 0;
  warmed = 0;
  constructor(private readonly delayMs = 0) {}

  warm(): void {
    this.warmed++;
  }

  async synth(text: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    this.calls.push(text);
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

  private async post(text: string, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${BREEZE_BASE}/v1/text-to-speech/${this.voiceId}/stream?output_format=pcm`, {
      method: "POST",
      headers: { "xi-api-key": this.cfg.apiKey ?? "", "content-type": "application/json" },
      // hey_voice.json: instructions 는 넣지 않는다(원본과 유사도가 떨어짐)
      body: JSON.stringify({ text, model_id: MODEL_ID, language_code: LANGUAGE, voice_settings: { use_speaker_boost: true } }),
      signal,
    });
  }

  warm(): void {
    // Bun 이 같은 호스트의 연결 풀을 재사용하므로, 첫 요청의 TLS 핸드셰이크(약 0.4초)를 LLM 을 기다리는 동안 끝내 둔다.
    try {
      fetch.preconnect(BREEZE_BASE);
    } catch {
      /* 미리 연결은 최적화일 뿐 */
    }
  }

  async synth(text: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    let res = await this.post(text, signal);
    if (res.status === 404 && !this.recreated && this.cfg.sampleFile) {
      this.recreated = true;
      this.voiceId = await this.recreateVoice(signal);
      res = await this.post(text, signal);
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
      body = await this.inner.synth(text, signal);
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
 * 고정 문장의 PCM 을 메모리에만 둔다(D-10: 디스크에 쓰지 않는다). 키는 목소리+문장, 가장 오래 안 쓴 것부터 버려 50MB 를 넘지 않는다.
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

  private key(text: string): string {
    return `${this.voiceKey}\u0000${text}`;
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
    const k = this.key(text);
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

  /**
   * 문장을 하나씩 합성해 담는다. 배경 작업이라 실제 턴이 쓸 자리를 남기고(자리가 둘 다 비었을 때만 하나 쓴다), 연속 2번 실패하면 멈춘다(키·크레딧 문제일 수 있다).
   * first 에 든 문장을 먼저 만든다(채움말처럼 서버가 뜨자마자 필요한 것).
   */
  async prime(texts: string[], signal: AbortSignal = new AbortController().signal, first: string[] = []): Promise<{ done: number; failed: number; entries: number; bytes: number }> {
    const order = [...new Set([...first, ...texts])];
    for (const t of order) this.keep.add(t);
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
}

/**
 * 문장이 완성되는 대로 TTS 를 시작하고, 결과 PCM 을 문장 순서대로 내보낸다. 동시 생성 수 제한은 제공자(GatedTts)가 맡는다.
 * 취소(signal)되면 아무것도 더 내보내지 않는다. 오디오는 메모리에서만 흐른다.
 */
export class AudioPipeline {
  private readonly jobs: Job[] = [];
  private closed = false;
  /** 어떤 문장이든 실패하면 더 이상 TTS 를 요청하지 않는다(크레딧 낭비 방지). */
  private failed = false;
  private kick: (() => void) | undefined;
  readonly done: Promise<void>;

  constructor(
    private readonly tts: TtsProvider,
    private readonly signal: AbortSignal,
    private readonly sink: AudioSink,
  ) {
    this.done = this.drain();
    // 취소되면 대기 중인 drain 이 깨어나 끝나도록 한다.
    signal.addEventListener("abort", () => this.finish(), { once: true });
  }

  add(sentence: string, filler = false): void {
    if (this.failed) return;
    const job: Job = { chunks: [], done: false, error: undefined, wake: undefined, filler };
    this.jobs.push(job);
    void this.generate(job, sentence);
    this.kick?.();
  }

  /** 더 이상 문장이 없다. */
  finish(): void {
    this.closed = true;
    this.kick?.();
  }

  private async generate(job: Job, sentence: string): Promise<void> {
    const notify = () => job.wake?.();
    try {
      for await (const c of await this.tts.synth(sentence, this.signal)) {
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
