import type { Clock } from "./clock";
import { AppError } from "./util";

interface Window {
  times: number[];
  windowMs: number;
}

/**
 * 기기(IP)별 요청 한도. 창 목록은 상한을 두고, 오래된 창은 지운다.
 * 시험에서는 FakeClock을 넣어 창 만료를 즉시 확인한다.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweepAt: number;

  /**
   * @param sweepMs 지난 창을 쓸어 내는 간격. 키 수가 상한에 닿기 전에도 주기적으로 지운다(기기 토큰별 키는 한 번 쓰고 사라진다).
   */
  constructor(
    private readonly clock: Clock,
    private readonly maxKeys = 10_000,
    private readonly sweepMs = 60_000,
  ) {
    this.lastSweepAt = clock.now();
  }

  hit(key: string, max: number, windowMs: number): void {
    const now = this.clock.now();
    if (now - this.lastSweepAt >= this.sweepMs) this.prune(now);
    const previous = this.windows.get(key);
    const recent = (previous?.times ?? []).filter((t) => now - t < windowMs);
    // 삭제 뒤 다시 넣어 Map 순서를 최근 사용 순으로 유지한다: 상한을 넘으면 맨 앞(가장 오래 안 쓴 키)만 O(1)로 버린다
    this.windows.delete(key);
    if (recent.length >= max) {
      this.windows.set(key, { times: recent, windowMs });
      throw new AppError("RATE_LIMITED", 429);
    }
    recent.push(now);
    this.windows.set(key, { times: recent, windowMs });
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }

  /** 창이 비었거나 모두 지난 항목을 지운다. */
  prune(now = this.clock.now()): void {
    this.lastSweepAt = now;
    for (const [key, window] of this.windows) {
      if (window.times.every((t) => now - t >= window.windowMs)) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
