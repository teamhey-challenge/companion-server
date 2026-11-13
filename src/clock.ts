/** 시간과 타이머를 주입 가능하게 만든다. 시험은 FakeClock으로 즉시 만료를 확인한다. */
export interface TimerHandle {
  readonly id: number;
  /** SystemClock이 들고 있는 실제 타이머. FakeClock은 쓰지 않는다. */
  readonly native?: unknown;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export class SystemClock implements Clock {
  private seq = 0;

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const native = setTimeout(fn, ms);
    native.unref?.();
    return { id: (this.seq += 1), native };
  }

  clearTimeout(handle: TimerHandle): void {
    if (handle.native !== undefined) clearTimeout(handle.native as NodeJS.Timeout);
  }
}

export type TimerErrorHandler = (key: string, error: unknown) => void;

/**
 * 이름이 붙은 타이머 한 곳. TTL·재전송·정리를 모두 여기서 예약하고 취소한다.
 * `size`가 0이면 이 컴포넌트가 타이머를 남기지 않았다는 뜻이다(누수 시험).
 */
export class TimerRegistry {
  private readonly timers = new Map<string, TimerHandle>();

  /**
   * @param onError 콜백이 던지거나(동기) 거부한(비동기) 오류를 받는다. 타이머 콜백의 오류가
   *   프로세스 밖으로 새면 서버가 조용히 죽으므로 여기서 모두 잡는다.
   */
  constructor(
    private readonly clock: Clock,
    private readonly onError: TimerErrorHandler = () => undefined,
  ) {}

  /** 콜백을 실행하되 오류는 onError로만 보낸다. onError 자체가 던져도 새지 않는다. */
  private guarded(key: string, fn: () => unknown): void {
    const report = (e: unknown): void => {
      try {
        this.onError(key, e);
      } catch {
        /* 보고 실패가 서버를 죽이지 않는다 */
      }
    };
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(report);
    } catch (e) {
      report(e);
    }
  }

  schedule(key: string, ms: number, fn: () => unknown): void {
    this.cancel(key);
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(key);
      this.guarded(key, fn);
    }, ms);
    this.timers.set(key, handle);
  }

  /** 같은 키로 반복한다. 콜백이 던져도 다음 주기는 예약된다. */
  every(key: string, ms: number, fn: () => unknown): void {
    this.cancel(key);
    const tick = (): void => {
      const handle = this.clock.setTimeout(() => {
        this.timers.delete(key);
        this.guarded(key, fn);
        tick();
      }, ms);
      this.timers.set(key, handle);
    };
    tick();
  }

  cancel(key: string): void {
    const handle = this.timers.get(key);
    if (!handle) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(key);
  }

  cancelAll(): void {
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }

  has(key: string): boolean {
    return this.timers.has(key);
  }
}
