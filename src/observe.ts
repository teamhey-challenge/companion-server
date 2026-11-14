import { shortId } from "./util";

/**
 * 운영 관찰 창구. Relay와 서버가 생애주기 이벤트·오류를 여기로만 보낸다.
 * 필드에는 토큰·원문 id를 넣지 않는다: 항상 `idHash`로 줄인 값만.
 */
export interface RelayObserver {
  /** 생애주기 이벤트 한 줄 (trip.created, ws.open …) */
  event(name: string, fields?: Record<string, string | number>): void;
  /** 예기치 않은 오류. 집계하고 한 줄 남긴다. */
  error(code: string, detail: string): void;
  /** 클라이언트에게 돌려준 정상적인 거절(HeyError). 집계만 하고 로그는 남기지 않는다. */
  reject(code: string): void;
}

export const NULL_OBSERVER: RelayObserver = {
  event: () => undefined,
  error: () => undefined,
  reject: () => undefined,
};

/** 로그에 쓰는 id의 짧은 해시 */
export const idHash = shortId;

/** 한 턴의 지연 기록. 시간은 서버가 말하기를 시작한 때(turn.end 처리)부터 잰다. */
export interface TurnTiming {
  /** 모델을 쓰지 않은 고정 문구 턴은 null */
  llmFirstTokenMs: number | null;
  /** 진짜 답의 첫 오디오 바이트까지. TTS 없음/실패면 null(채움말은 세지 않는다) */
  firstTtsByteMs: number | null;
  /** 채움말을 포함해 처음 소리가 난 때 */
  firstAudioMs?: number | null;
  /** 채움말이 나갔다면 그 첫 바이트 시각 */
  fillerMs?: number | null;
  /** 첫 조각(문장 또는 첫 쉼표/띄어쓰기 조각)이 TTS 로 넘어간 때와 그 글자 수. 이 값과 firstTtsByteMs 의 차이가 TTS 요청→첫 바이트(+대기)다. */
  firstPieceMs?: number | null;
  firstPieceChars?: number | null;
  totalMs: number;
  model: string;
}

interface Pct {
  p50: number;
  p95: number;
}

export interface LatencySummary {
  n: number;
  llmFirstTokenMs: Pct | null;
  firstTtsByteMs: Pct | null;
  firstAudioMs: Pct | null;
  fillers: number;
  totalMs: Pct | null;
  models: Record<string, number>;
}

const TIMING_WINDOW = 50;

function stat(values: Array<number | null | undefined>): Pct | null {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p: number) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]!;
  return { p50: at(50), p95: at(95) };
}

export interface ErrorSummary {
  counts: Record<string, number>;
  last?: { code: string; ageMs: number };
}

/** 한 줄 JSON 로그 + 오류 코드 집계. 로그 쓰기가 던져도 서버로 새지 않는다. */
export class Observability implements RelayObserver {
  private readonly counts = new Map<string, number>();
  private readonly timings: TurnTiming[] = [];
  private last: { code: string; at: number } | undefined;

  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private emit(record: Record<string, unknown>): void {
    try {
      this.write(JSON.stringify({ ts: new Date(this.now()).toISOString(), ...record }));
    } catch {
      /* 로그 실패(닫힌 파이프 등)가 요청을 죽이지 않는다 */
    }
  }

  private bump(code: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    this.last = { code, at: this.now() };
  }

  event(name: string, fields: Record<string, string | number> = {}): void {
    this.emit({ ev: name, ...fields });
  }

  error(code: string, detail: string): void {
    this.bump(code);
    this.emit({ ev: "error", code, detail: detail.slice(0, 200) });
  }

  reject(code: string): void {
    this.bump(code);
  }

  /** 턴 지연 한 줄 로그 + 최근 50턴 링. 값이 없으면 -1. */
  turn(t: TurnTiming): void {
    this.timings.push(t);
    if (this.timings.length > TIMING_WINDOW) this.timings.shift();
    this.emit({
      ev: "talk.timing",
      llm_first_token_ms: t.llmFirstTokenMs ?? -1,
      first_tts_byte_ms: t.firstTtsByteMs ?? -1,
      first_audio_ms: t.firstAudioMs ?? -1,
      filler_ms: t.fillerMs ?? -1,
      first_piece_ms: t.firstPieceMs ?? -1,
      first_piece_chars: t.firstPieceChars ?? -1,
      total_ms: t.totalMs,
      model: t.model,
    });
  }

  latency(): LatencySummary {
    const models: Record<string, number> = {};
    for (const t of this.timings) models[t.model] = (models[t.model] ?? 0) + 1;
    return {
      n: this.timings.length,
      llmFirstTokenMs: stat(this.timings.map((t) => t.llmFirstTokenMs)),
      firstTtsByteMs: stat(this.timings.map((t) => t.firstTtsByteMs)),
      firstAudioMs: stat(this.timings.map((t) => t.firstAudioMs)),
      fillers: this.timings.filter((t) => typeof t.fillerMs === "number").length,
      totalMs: stat(this.timings.map((t) => t.totalMs)),
      models,
    };
  }

  errors(): ErrorSummary {
    return {
      counts: Object.fromEntries(this.counts),
      ...(this.last ? { last: { code: this.last.code, ageMs: this.now() - this.last.at } } : {}),
    };
  }
}
