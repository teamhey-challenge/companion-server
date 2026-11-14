#!/usr/bin/env bun
/**
 * 시연용 기억 넣기(PLEOS-167). 라이브 추출에 기대지 않고 H1("어제 한 말을 기억해서 먼저 꺼낸다") 장면을 만든다.
 * 서버가 쓰는 것과 같은 저장소(ApiStore.addMemory)로 기억 한 줄(FACT)만 쓴다. 대화 원문은 저장하지 않는다.
 *
 *   bun scripts/seed-memory.ts --car <installId|current-audit-car> --fact '오늘 면접 보러 간다' [--when yesterday|today|<N>d|<ISO>] [--reset-greeting] [--db <path>]
 *
 * --car current-audit-car : cars 표에서 가장 최근에 등록된 차.
 * --when                  : 기억이 만들어진 때. yesterday = 24시간 전(KST 날짜가 어제가 되는 시각), Nd = N일 전.
 * --reset-greeting        : 그날 첫 인사 상태(lastGreetingDay)를 비워 다음 첫 P 에서 인사 줄이 다시 나가게 한다.
 * DB 경로 기본값: $COMPANION_DATA_DIR/companion.sqlite(없으면 ./data).
 * 기억 동의나 기억 설정이 꺼져 있으면 서버가 읽지 않으므로 경고한다(쓰기는 한다).
 */
import { parseArgs } from "node:util";
import { ApiStore } from "../src/api-store";
import type { Clock } from "../src/clock";
import { SystemClock } from "../src/clock";
import { CarStore } from "../src/store";

const DAY_MS = 86_400_000;

/** `--when` 값을 기억 생성 시각(ms)으로. */
export function resolveWhen(when: string, nowMs: number): number {
  const w = when.trim();
  if (w === "today" || w === "now") return nowMs;
  if (w === "yesterday") return nowMs - DAY_MS;
  const m = /^(\d+)d$/.exec(w);
  if (m) return nowMs - Number(m[1]) * DAY_MS;
  const t = Date.parse(w);
  if (!Number.isFinite(t)) throw new Error(`--when: yesterday | today | <N>d | ISO 시각이어야 합니다: ${when}`);
  return t;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      car: { type: "string" },
      fact: { type: "string" },
      when: { type: "string", default: "today" },
      db: { type: "string" },
      "reset-greeting": { type: "boolean", default: false },
    },
  });
  if (!values.car || !values.fact) {
    console.error("usage: bun scripts/seed-memory.ts --car <installId|current-audit-car> --fact '<한 문장>' [--when yesterday] [--reset-greeting] [--db <path>]");
    process.exit(2);
  }
  const fact = values.fact.trim();
  if (fact.length < 2 || fact.length > 80) {
    console.error("--fact 는 2~80자 한 문장이어야 합니다.");
    process.exit(2);
  }
  const dbPath = values.db ?? `${process.env.COMPANION_DATA_DIR || "./data"}/companion.sqlite`;
  const sys = new SystemClock();
  const at = resolveWhen(values.when ?? "today", sys.now());
  // 서버와 같은 저장소 코드로 쓰되 시계만 기억 생성 시각으로 고정한다.
  const fixedClock: Clock = { now: () => at, setTimeout: (f, ms) => sys.setTimeout(f, ms), clearTimeout: (h) => sys.clearTimeout(h) };
  const cars = new CarStore(dbPath, sys);
  const api = new ApiStore(cars.db, fixedClock);

  let installId = values.car;
  if (installId === "current-audit-car") {
    const row = cars.db.query("SELECT install_id FROM cars ORDER BY created_at DESC LIMIT 1").get() as { install_id: string } | null;
    if (!row) {
      console.error("등록된 차가 없습니다(cars 표가 비어 있음).");
      process.exit(1);
    }
    installId = row.install_id;
  }
  const item = api.addMemory(installId, "fact", fact);
  if (values["reset-greeting"]) api.patchTalkState(installId, { lastGreetingDay: null });
  console.log(`seeded memory id=${item.id.slice(0, 8)} car=${installId.slice(0, 8)}… createdAt=${item.createdAt}${values["reset-greeting"] ? " greeting-reset" : ""}`);
  if (!api.memoryAllowed(installId)) console.warn("경고: 이 차는 기억 동의/설정이 꺼져 있어 서버가 이 기억을 읽지 않습니다.");
}
