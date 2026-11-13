import { appendFileSync } from "node:fs";

/** 코드가 깨뜨려선 안 되는 불변식을 깼을 때 던진다. 프로세스를 내린다(요청 단위 오류와 다르다). */
export class InvariantError extends Error {
  constructor(message: string) {
    super(`invariant: ${message}`);
    this.name = "InvariantError";
  }
}

/** process 중 가드가 쓰는 부분. 시험은 가짜를 넣는다. */
export interface GuardedProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): unknown;
}

export interface GuardOptions {
  proc?: GuardedProcess;
  /** 오류 한 줄을 남긴다 (Observability.error) */
  onError: (code: string, detail: string) => void;
  /** 종료 전 정리(서버 정지) */
  onFatal?: () => void;
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e).slice(0, 200);
}

/**
 * 프로세스 수준 방어.
 * - unhandledRejection / uncaughtException: 기록하고 계속 선다. 단 InvariantError면 기록 후 exit(70).
 * - SIGHUP: 무시한다. 부모 셸·터미널이 닫혀도 Bun 기본 동작(종료)을 타지 않는다.
 * - SIGINT/SIGTERM: 정리 후 exit(0).
 */
export function installProcessGuards(opts: GuardOptions): void {
  const proc = opts.proc ?? (process as unknown as GuardedProcess);
  const onFault = (code: string) => (e: unknown) => {
    opts.onError(code, describe(e));
    if (e instanceof InvariantError) {
      opts.onFatal?.();
      proc.exit(70);
    }
  };
  proc.on("unhandledRejection", onFault("UNHANDLED_REJECTION"));
  proc.on("uncaughtException", onFault("UNCAUGHT_EXCEPTION"));
  proc.on("SIGHUP", () => opts.onError("SIGHUP_IGNORED", "controlling terminal closed"));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    proc.on(sig, () => {
      opts.onFatal?.();
      proc.exit(0);
    });
  }
}

/**
 * 로그 쓰기. 한 번 실패(EPIPE 등)해도 던지지 않고 다음 줄도 시도한다.
 * `file`이 있으면 파일에 덧붙이고, 없으면 stdout.
 */
export function makeLogWriter(file?: string): (line: string) => void {
  if (file === undefined) {
    process.stdout.on("error", () => undefined);
    return (line) => {
      try {
        process.stdout.write(`${line}\n`);
      } catch {
        /* 닫힌 파이프 */
      }
    };
  }
  return (line) => {
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* 디스크 오류가 서버를 죽이지 않는다 */
    }
  };
}
