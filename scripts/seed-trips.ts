#!/usr/bin/env bun
/**
 * 시연용 '함께 다닌 길' 시드(프로토타입). 서버와 같은 저장소 코드로 차 한 대, 동의, 기억 몇 개, 길 여러 개를 쓰고
 * 폰이 연결할 8자리 코드를 하나 만든다(코드는 5분 안에 한 번만 쓰인다). 좌표는 없다.
 *
 *   bun scripts/seed-trips.ts [--db <path>] [--car <installId>]
 *
 * 값은 모두 가짜다(시연용). 지역은 목적지 이름에서 읽은 것이 아니라 시드가 정한 값이다.
 */
import { parseArgs } from "node:util";
import { ApiStore } from "../src/api-store";
import { SystemClock, type Clock } from "../src/clock";
import { CarStore } from "../src/store";

const DAY = 86_400_000;
const { values } = parseArgs({ options: { db: { type: "string" }, car: { type: "string", default: "demo-trips-car-01" } } });
const dbPath = values.db ?? `${process.env.COMPANION_DATA_DIR || "./data"}/companion.sqlite`;
const sys = new SystemClock();
const cars = new CarStore(dbPath, sys);
const api = new ApiStore(cars.db, sys);
const car = values.car!;

cars.register(car);
for (const t of ["terms", "privacy", "record", "memory", "external_ai"] as const) api.setConsent(car, t, "1", true);
api.deleteAllTrips(car);
api.deleteAllMemory(car);

// 시계를 길 시각에 맞춰 쓰기 위해 같은 DB 에 시각이 다른 ApiStore 를 만든다.
const at = (ms: number): Clock => ({ now: () => ms, setTimeout: (f, d) => sys.setTimeout(f, d), clearTimeout: (h) => sys.clearTimeout(h) });
const now = Date.now();
const kstNoon = (daysAgo: number, hour = 9) => {
  const d = new Date(now - daysAgo * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 9, 10);
};

interface Seed { ago: number; hour?: number; min: number; km: number | null; dest: string | null; sido?: string; gu?: string; parked?: number }
const SEEDS: Seed[] = [
  { ago: 21, min: 25, km: 12.4, dest: "회사", sido: "경기도", gu: "하남시" },
  { ago: 20, hour: 18, min: 30, km: 12.1, dest: "집", sido: "경기도", gu: "하남시" },
  { ago: 18, min: 28, km: 12.3, dest: "회사", sido: "경기도", gu: "하남시" },
  { ago: 17, hour: 19, min: 33, km: 11.9, dest: "집", sido: "경기도", gu: "하남시" },
  { ago: 14, hour: 14, min: 55, km: 38.0, dest: "코엑스", sido: "서울특별시", gu: "강남구", parked: 6 },
  { ago: 13, min: 26, km: 12.2, dest: "회사", sido: "경기도", gu: "하남시" },
  { ago: 12, hour: 18, min: 31, km: 12.0, dest: "집", sido: "경기도", gu: "하남시" },
  { ago: 10, hour: 11, min: 70, km: 55.5, dest: "가평 카페", sido: "경기도", gu: "가평군", parked: 1 },
  { ago: 4, min: 27, km: 12.3, dest: "회사", sido: "경기도", gu: "하남시" },
  { ago: 3, hour: 13, min: 40, km: 24.7, dest: "스타필드 하남", sido: "경기도", gu: "하남시" },
  { ago: 1, hour: 10, min: 62, km: null, dest: null, sido: "서울특별시", gu: "송파구" },
  { ago: 0, hour: 8, min: 22, km: 11.8, dest: "회사", sido: "경기도", gu: "하남시", parked: 2 },
];
for (const s of SEEDS) {
  const start = kstNoon(s.ago, s.hour ?? 8);
  const end = start + s.min * 60_000;
  const store = new ApiStore(cars.db, at(end + 60_000));
  store.recordTrip(car, { startedAt: start, endedAt: end, distanceKm: s.km, destination: s.dest, sido: s.sido ?? null, sigungu: s.gu ?? null, regionDemo: true });
  for (let i = 0; i < (s.parked ?? 0); i++) store.addParkedTurn(car);
}
for (const [i, text] of ["다음 주 토요일에 친구 만나기로 했어", "커피는 아이스 아메리카노를 좋아함", "요즘 면접 준비 중", "강아지 이름은 보리", "주말에 가평 가고 싶어함"].entries()) {
  new ApiStore(cars.db, at(now - (5 - i) * DAY)).addMemory(car, "fact", text);
}

const { pairCode, expiresAt } = api.createPairing(car);
console.log(`seeded car=${car} trips=${api.listTrips(car).length} memories=5`);
console.log(`pair code (single use, expires ${expiresAt}): ${pairCode}`);
