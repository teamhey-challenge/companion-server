import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import type { Clock } from "./clock";
import type { TimerRegistry } from "./clock";

/** 임시 파일에 쓰고 fsync한 뒤 이름을 바꾼다. 도중에 죽어도 옛 파일이나 새 파일 중 하나만 남는다. */
export function atomicWriteJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** 파일이 없으면 undefined. JSON이 아니면 던진다(호출자가 로그를 남기고 빈 상태로 시작한다). */
export function readJsonFile(file: string): unknown {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 쓰기를 모아서 한다. 마지막 쓰기 뒤 `intervalMs`가 지났으면 바로 쓰고(첫 등록은 즉시 남는다),
 * 아니면 간격이 찰 때 한 번만 쓴다. 쓰기에 실패하면 `dirty`를 남기고 다음 간격에 다시 시도한다.
 * 타이머는 TimerRegistry에 두므로 `cancelAll`이 정리한다. 종료 때는 `flush()`를 부른다.
 */
export class CoalescedWriter {
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private dirty = false;

  constructor(
    private readonly clock: Clock,
    private readonly timers: TimerRegistry,
    private readonly key: string,
    private readonly intervalMs: number,
    private readonly write: () => void,
    private readonly onError: (e: unknown) => void,
  ) {}

  request(): void {
    this.dirty = true;
    if (this.timers.has(this.key)) return;
    const wait = this.lastWriteAt + this.intervalMs - this.clock.now();
    if (wait <= 0) this.run();
    else this.timers.schedule(this.key, wait, () => this.run());
  }

  /** 밀린 쓰기가 있으면 지금 한다. */
  flush(): void {
    this.timers.cancel(this.key);
    if (this.dirty) this.run(false);
  }

  private run(retry = true): void {
    this.dirty = false;
    this.lastWriteAt = this.clock.now();
    try {
      this.write();
    } catch (e) {
      this.dirty = true;
      this.onError(e);
      if (retry) this.timers.schedule(this.key, this.intervalMs, () => this.run());
    }
  }
}
