import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ApiStore } from "../src/api-store";
import type { Clock, TimerHandle } from "../src/clock";
import { findRegion } from "../src/regions";
import { cleanDestination, computeBadges, computeRegions, pickRegion, type TripRow } from "../src/trips";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0); // 월요일 10시 KST

class FakeClock implements Clock {
  t = T0;
  now() { return this.t; }
  setTimeout(): TimerHandle { return { id: 0 }; }
  clearTimeout() {}
}

let seq = 0;
const trip = (o: Partial<TripRow> & { day?: number }): TripRow => {
  const startedAt = T0 + (o.day ?? 0) * DAY;
  return {
    id: `t${++seq}`, startedAt, endedAt: startedAt + 20 * 60_000, distanceKm: null, destination: null,
    sido: null, sigungu: null, regionDemo: false, parkedTurns: 0, ...o,
  };
};
const earned = (trips: TripRow[], memories = 0) => computeBadges(trips, memories, null, T0 + 99 * DAY).filter((b) => b.earned).map((b) => b.id);

test("first ride and new region", () => {
  expect(earned([])).toEqual([]);
  expect(earned([trip({})])).toEqual(["first-ride"]);
  expect(earned([trip({ sido: "경기도", sigungu: "하남시" })])).toEqual(["first-ride", "new-region"]);
});

test("regular needs five different days at the same place; same-day repeats count once", () => {
  const same = Array.from({ length: 6 }, () => trip({ day: 0, destination: "스타필드 하남" }));
  expect(earned(same)).not.toContain("regular");
  const days = Array.from({ length: 5 }, (_, i) => trip({ day: i, destination: "스타필드 하남" }));
  expect(earned(days)).toContain("regular");
  expect(earned(days.slice(0, 4))).not.toContain("regular");
});

test("steady road: ten round trips between the same two places", () => {
  const ping = Array.from({ length: 22 }, (_, i) => trip({ day: i, destination: i % 2 ? "회사" : "집" }));
  expect(earned(ping)).toContain("steady-road");
  expect(earned(ping.slice(0, 10))).not.toContain("steady-road");
});

test("parked chat badges", () => {
  expect(earned([trip({ parkedTurns: 1 })])).toContain("relaxed-day");
  expect(earned([trip({ parkedTurns: 1 })])).not.toContain("parking-master");
  expect(earned([trip({ parkedTurns: 5 })])).toContain("parking-master");
});

test("welcome back after more than 7 days", () => {
  expect(earned([trip({ day: 0 }), trip({ day: 6 })])).not.toContain("welcome-back");
  expect(earned([trip({ day: 0 }), trip({ day: 9 })])).toContain("welcome-back");
});

test("memory keeper from five memories", () => {
  expect(earned([], 4)).toEqual([]);
  expect(earned([], 5)).toEqual(["memory-keeper"]);
});

test("badges never read speed, distance or duration: wildly different trips earn the same", () => {
  const calm = [trip({ day: 0, distanceKm: 3 })];
  const wild = [{ ...trip({ day: 0, distanceKm: 900 }), endedAt: T0 + 60_000 }];
  expect(earned(calm)).toEqual(earned(wild));
});

test("regions list only visited places and no totals", () => {
  const r = computeRegions([trip({ sido: "경기도", sigungu: "하남시" }), trip({ day: 1, sido: "경기도", sigungu: "하남시" }), trip({ day: 2, sido: "서울특별시", sigungu: "강남구", regionDemo: true })]);
  expect(r.map((g) => g.sido)).toEqual(["서울특별시", "경기도"]);
  expect(r[1]!.unlocked).toEqual([expect.objectContaining({ name: "하남시", trips: 2, demo: false })]);
  expect(r[0]!.unlocked[0]!.demo).toBe(true);
  expect(Object.keys(r[0]!)).toEqual(["sido", "unlocked"]);
});

test("region matching: from name, ambiguity yields null, demo flag last", () => {
  expect(findRegion("경기도 하남시")).toEqual({ sido: "경기도", sigungu: "하남시" });
  expect(findRegion("서울 강남구 코엑스")).toEqual({ sido: "서울특별시", sigungu: "강남구" });
  expect(findRegion("중구 어딘가")).toBeNull();
  expect(findRegion("편의점")).toBeNull();
  expect(pickRegion("서울특별시 송파구", "스타필드 하남", "제주도")?.sigungu).toBe("송파구");
  expect(pickRegion(undefined, "스타필드 하남시", undefined)).toEqual({ sido: "경기도", sigungu: "하남시", demo: false });
  expect(pickRegion(undefined, "어딘가", "경기도 하남시")).toEqual({ sido: "경기도", sigungu: "하남시", demo: true });
  expect(pickRegion(undefined, "어딘가", undefined)).toBeNull();
});

test("coordinates never survive as a destination", () => {
  expect(cleanDestination("37.5665, 126.9780")).toBeNull();
  expect(cleanDestination("  스타필드   하남 ")).toBe("스타필드 하남");
  expect(cleanDestination("가".repeat(80))!.length).toBe(40);
});

function store() {
  const clock = new FakeClock();
  const db = new Database(":memory:");
  return { clock, db, api: new ApiStore(db, clock) };
}
const consent = (api: ApiStore, id: string) => { api.setConsent(id, "memory", "1", true); api.setConsent(id, "record", "1", true); };
const rec = (api: ApiStore, id: string, extra: Partial<TripRow> = {}) =>
  api.recordTrip(id, { startedAt: T0, endedAt: T0 + 600_000, distanceKm: 4.2, destination: "스타필드 하남", sido: "경기도", sigungu: "하남시", regionDemo: false, ...extra });

test("no trip is recorded without memory consent", () => {
  const { api } = store();
  expect(rec(api, "car-aaaa1")).toBeNull();
  expect(api.listTrips("car-aaaa1")).toEqual([]);
  consent(api, "car-aaaa1");
  expect(rec(api, "car-aaaa1")).not.toBeNull();
  api.patchSettings("car-aaaa1", { memoryEnabled: false });
  expect(rec(api, "car-aaaa1")).toBeNull();
  expect(api.tripsResponse("car-aaaa1").enabled).toBe(false);
});

test("deleting one trip, all memory, or withdrawing consent wipes trips; other cars untouched", () => {
  const { api } = store();
  consent(api, "car-aaaa1");
  consent(api, "car-bbbb1");
  const id = rec(api, "car-aaaa1")!;
  rec(api, "car-aaaa1");
  rec(api, "car-bbbb1");
  expect(api.deleteTrip("car-bbbb1", id)).toBe(false);
  expect(api.deleteTrip("car-aaaa1", id)).toBe(true);
  expect(api.listTrips("car-aaaa1")).toHaveLength(1);
  api.deleteAllMemory("car-aaaa1");
  expect(api.listTrips("car-aaaa1")).toHaveLength(0);
  expect(api.listTrips("car-bbbb1")).toHaveLength(1);
  api.withdrawConsent("car-bbbb1", "memory");
  expect(api.listTrips("car-bbbb1")).toHaveLength(0);
});

test("parked turns attach to the latest trip within 30 minutes only", () => {
  const { api, clock } = store();
  consent(api, "car-aaaa1");
  clock.t = T0 + 700_000;
  rec(api, "car-aaaa1");
  api.addParkedTurn("car-aaaa1");
  api.addParkedTurn("car-aaaa1");
  expect(api.listTrips("car-aaaa1")[0]!.parkedTurns).toBe(2);
  clock.t = T0 + 3 * 3600_000;
  api.addParkedTurn("car-aaaa1");
  expect(api.listTrips("car-aaaa1")[0]!.parkedTurns).toBe(2);
});
