import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ApiStore } from "../src/api-store";
import type { Clock, TimerHandle } from "../src/clock";
import { RateLimiter } from "../src/rate-limit";
import { Observability } from "../src/observe";
import { talkHandlers, type Ws } from "../src/talk";

class FakeClock implements Clock {
  t = 1_800_000_000_000;
  now() { return this.t; }
  setTimeout(): TimerHandle { return { id: 0 }; }
  clearTimeout() {}
}

const CAR = "install-trip01";

function rig(consent = true, demoRegion?: string) {
  const clock = new FakeClock();
  const api = new ApiStore(new Database(":memory:"), clock);
  if (consent) for (const t of ["memory", "record", "external_ai"] as const) api.setConsent(CAR, t, "1", true);
  const cfg = { providerName: "openai-compatible", model: "m", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 };
  const h = talkHandlers(cfg, new Observability(() => {}), {
    guard: { turnsPerMin: 99, turnsPerDay: 99 }, limiter: new RateLimiter(clock), store: api, clock, demoRegion,
  });
  const ws: Ws = { send: () => {}, close: () => {}, data: { id: "c1", installId: CAR, sessionId: "s", hello: false } };
  h.open(ws);
  const send = (o: unknown) => h.message(ws, JSON.stringify(o));
  return { clock, api, send, ctx: (c: Record<string, unknown>) => send({ type: "ctx", ctx: c }) };
}

test("D then P records one trip with odometer delta and destination name, no coordinates", async () => {
  const r = rig();
  await r.send({ type: "hello", v: 1, appVersion: "t" });
  await r.ctx({ gear: "P", odoKm: 1000 });
  r.clock.t += 5_000;
  await r.ctx({ gear: "D", odoKm: 1000, destName: "스타필드 하남", region: "경기도 하남시", lat: 37.5, lng: 127.2 });
  r.clock.t += 20 * 60_000;
  await r.ctx({ gear: "D", odoKm: 1012.34 });
  await r.ctx({ gear: "P", odoKm: 1012.34 });
  const trips = r.api.listTrips(CAR);
  expect(trips).toHaveLength(1);
  expect(trips[0]).toMatchObject({ destination: "스타필드 하남", distanceKm: 12.3, sido: "경기도", sigungu: "하남시", regionDemo: false });
  expect(JSON.stringify(trips)).not.toMatch(/37\.5|127\.2|lat|lng/);
  await r.ctx({ gear: "P", odoKm: 1012.34 });
  expect(r.api.listTrips(CAR)).toHaveLength(1);
});

test("gear flicker under 30 s is not a trip; no odometer gives null distance; demo region is flagged", async () => {
  const r = rig(true, "경기도 하남시");
  await r.send({ type: "hello", v: 1, appVersion: "t" });
  await r.ctx({ gear: "P" });
  await r.ctx({ gear: "D" });
  r.clock.t += 5_000;
  await r.ctx({ gear: "P" });
  expect(r.api.listTrips(CAR)).toHaveLength(0);
  await r.ctx({ gear: "D" });
  r.clock.t += 120_000;
  await r.ctx({ gear: "P" });
  const t = r.api.listTrips(CAR);
  expect(t).toHaveLength(1);
  expect(t[0]).toMatchObject({ distanceKm: null, destination: null, sigungu: "하남시", regionDemo: true });
});

test("without memory consent nothing is recorded", async () => {
  const r = rig(false);
  await r.send({ type: "hello", v: 1, appVersion: "t" });
  await r.ctx({ gear: "P" });
  await r.ctx({ gear: "D" });
  r.clock.t += 120_000;
  await r.ctx({ gear: "P" });
  expect(r.api.listTrips(CAR)).toHaveLength(0);
});
