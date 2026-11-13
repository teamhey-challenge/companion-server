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

export interface ErrorSummary {
  counts: Record<string, number>;
  last?: { code: string; ageMs: number };
}

/** 한 줄 JSON 로그 + 오류 코드 집계. 로그 쓰기가 던져도 서버로 새지 않는다. */
export class Observability implements RelayObserver {
  private readonly counts = new Map<string, number>();
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

  errors(): ErrorSummary {
    return {
      counts: Object.fromEntries(this.counts),
      ...(this.last ? { last: { code: this.last.code, ageMs: this.now() - this.last.at } } : {}),
    };
  }
}
