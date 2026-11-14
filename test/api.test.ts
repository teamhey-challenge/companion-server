import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Clock, TimerHandle } from "../src/clock";
import { Observability } from "../src/observe";
import { createServer, type RunningServer } from "../src/server";

class FakeClock implements Clock {
  t = 1_800_000_000_000;
  now() { return this.t; }
  setTimeout(): TimerHandle { return { id: 0 }; }
  clearTimeout() {}
}

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 };
let servers: RunningServer[] = [];
afterEach(() => { for (const s of servers) void s.stop(true); servers = []; });

interface Pairing { status: string; pairCode?: string; pairedAt?: string }
interface MemPage { items: { id: string; kind: string; text: string }[]; nextCursor: string | null }

function boot(publicPerMin = 100) {
  const clock = new FakeClock();
  const pushed: [string, unknown][] = [];
  const dbPath = `${mkdtempSync(`${tmpdir()}/api-`)}/c.db`;
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath, clock, publicPerMin,
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 1000 },
    hub: { pushSettings: (id, st) => pushed.push([id, st]) },
  });
  servers.push(s);
  const base = `http://127.0.0.1:${s.port}`;
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const car = async (installId: string) => {
    const res = await fetch(`${base}/v1/cars/register`, { method: "POST", headers: { "x-provision-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify({ installId }) });
    const j: { carToken: string } = await res.json();
    return j.carToken;
  };
  const newCode = async (carToken: string): Promise<string> => {
    const j: { pairCode: string } = await (await call("POST", "/v1/pairings", carToken)).json();
    return j.pairCode;
  };
  const pair = async (carToken: string, memory = true) => {
    const pairCode = await newCode(carToken);
    const res = await call("POST", `/v1/pairings/${pairCode}/claim`, undefined, { record: true, memory });
    const j: { phoneToken: string } = await res.json();
    return { pairCode, phoneToken: j.phoneToken };
  };
  /** 기억 쓰기는 ServerTalk 몫이라 시험에서는 같은 DB 파일에 직접 넣는다. */
  const seedMemory = (installId: string, n: number) => {
    const db = new Database(dbPath);
    for (let i = 0; i < n; i++) {
      db.query("INSERT INTO memory (id, install_id, kind, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(`m-${installId}-${i}`, installId, i % 2 ? "summary" : "fact", `t${i}`, clock.t);
    }
    db.close();
  };
  const memory = async (token: string): Promise<MemPage> => (await call("GET", "/v1/memory?limit=100", token)).json();
  const current = async (token: string): Promise<Pairing> => (await call("GET", "/v1/pairings/current", token)).json();
  return { clock, call, car, newCode, pair, pushed, seedMemory, memory, current, dbPath };
}

test("phone token sees only its paired car; scope limits", async () => {
  const { call, car, pair } = boot();
  const a = await car("install-aaaa1");
  const b = await car("install-bbbb1");
  const pa = await pair(a);
  const pb = await pair(b);
  await call("PATCH", "/v1/settings", a, { nickname: "하늘" });
  const mine: { nickname: string | null } = await (await call("GET", "/v1/settings", pa.phoneToken)).json();
  const theirs: { nickname: string | null } = await (await call("GET", "/v1/settings", pb.phoneToken)).json();
  expect(mine.nickname).toBe("하늘");
  expect(theirs.nickname).toBeNull();
  expect((await call("PATCH", "/v1/settings", pa.phoneToken, { proactive: "off" })).status).toBe(403);
  expect((await call("PATCH", "/v1/settings", pa.phoneToken, { speech: "jondaetmal" })).status).toBe(200);
  expect((await call("POST", "/v1/pairings", pa.phoneToken)).status).toBe(403);
  expect((await call("DELETE", "/v1/pairings/current", pa.phoneToken)).status).toBe(403);
  expect((await call("POST", "/v1/vehicle-events", pa.phoneToken, [])).status).toBe(403);
  expect((await call("GET", "/v1/settings")).status).toBe(401);
  expect((await call("GET", "/v1/settings", "nope")).status).toBe(401);
});

test("memory is scoped per car, paged, deletable one and all", async () => {
  const { call, car, pair, seedMemory, memory } = boot();
  const a = await car("install-aaaa1");
  const b = await car("install-bbbb1");
  const pa = await pair(a);
  seedMemory("install-aaaa1", 5);
  seedMemory("install-bbbb1", 2);
  expect((await memory(b)).items.length).toBe(2);
  const p1: MemPage = await (await call("GET", "/v1/memory?limit=3", pa.phoneToken)).json();
  expect(p1.items.map((i) => i.text)).toEqual(["t4", "t3", "t2"]);
  const p2: MemPage = await (await call("GET", `/v1/memory?limit=3&cursor=${p1.nextCursor}`, a)).json();
  expect(p2.items.map((i) => i.text)).toEqual(["t1", "t0"]);
  expect(p2.nextCursor).toBeNull();
  // 다른 차의 항목은 지워지지 않는다
  await call("DELETE", "/v1/memory/m-install-bbbb1-0", a);
  expect((await memory(b)).items.length).toBe(2);
  await call("DELETE", "/v1/memory/m-install-aaaa1-4", a);
  expect((await memory(a)).items.length).toBe(4);
  expect((await call("DELETE", "/v1/memory", pa.phoneToken)).status).toBe(204);
  expect((await memory(a)).items.length).toBe(0);
  expect((await memory(b)).items.length).toBe(2);
});

test("withdrawing record or memory consent deletes memory and summaries immediately", async () => {
  const { call, car, seedMemory, memory } = boot();
  const a = await car("install-aaaa1");
  const consent = (type: string) => call("POST", "/v1/consents", a, { type, version: "1", granted: true, channel: "car" });
  expect((await consent("record")).status).toBe(200);
  seedMemory("install-aaaa1", 4);
  expect((await call("DELETE", "/v1/consents/record", a)).status).toBe(204);
  expect((await memory(a)).items.length).toBe(0);
  seedMemory("install-aaaa1", 3);
  expect((await call("DELETE", "/v1/consents/privacy", a)).status).toBe(204);
  expect((await memory(a)).items.length).toBe(3);
  expect((await call("DELETE", "/v1/consents/memory", a)).status).toBe(204);
  expect((await memory(a)).items.length).toBe(0);
  const list: { consents: { type: string; granted: boolean }[] } = await (await call("GET", "/v1/consents", a)).json();
  expect(list.consents.find((c) => c.type === "memory")?.granted).toBe(false);
  // 잘못된 값
  expect((await call("POST", "/v1/consents", a, { type: "x", version: "1", granted: true, channel: "car" })).status).toBe(400);
  expect((await call("POST", "/v1/consents", a, { type: "terms", version: "1", granted: true, channel: "phone" })).status).toBe(400);
  expect((await call("DELETE", "/v1/consents/x", a)).status).toBe(400);
});

test("pairing: code format, new code invalidates old, claim once, expiry, unknown", async () => {
  const { call, car, newCode, clock, current } = boot();
  const a = await car("install-aaaa1");
  const c1 = await newCode(a);
  expect(c1).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  expect((await current(a)).status).toBe("pending");
  const c2 = await newCode(a);
  expect(c2).not.toBe(c1);
  const old: { status: string } = await (await call("GET", `/v1/pairings/${c1}`)).json();
  expect(old.status).toBe("expired");
  expect((await call("POST", `/v1/pairings/${c1}/claim`, undefined, { record: true, memory: false })).status).toBe(410);
  const pub: { status: string; character: { name: string } } = await (await call("GET", `/v1/pairings/${c2}`)).json();
  expect(pub).toMatchObject({ status: "pending", character: { name: "헤이파리" } });
  const unknown = await call("GET", "/v1/pairings/ZZZZZZZZ");
  expect(unknown.status).toBe(200);
  expect(((await unknown.json()) as { status: string }).status).toBe("unknown");
  expect((await call("GET", "/v1/pairings/abc")).status).toBe(200);
  expect((await call("POST", `/v1/pairings/${c2}/claim`, undefined, { record: false, memory: true })).status).toBe(400);
  const ok = await call("POST", `/v1/pairings/${c2}/claim`, undefined, { record: true, memory: false });
  expect(ok.status).toBe(200);
  expect((await call("POST", `/v1/pairings/${c2}/claim`, undefined, { record: true, memory: false })).status).toBe(409);
  expect((await current(a)).status).toBe("claimed");
  expect(((await (await call("GET", `/v1/pairings/${c2}`)).json()) as { status: string }).status).toBe("claimed");
  // 5분 지나면 만료
  const a2 = await car("install-cccc1");
  const c3 = await newCode(a2);
  clock.t += 5 * 60_000 + 1;
  expect(((await (await call("GET", `/v1/pairings/${c3}`)).json()) as { status: string }).status).toBe("expired");
  expect((await current(a2)).status).toBe("expired");
  expect((await call("POST", `/v1/pairings/${c3}/claim`, undefined, { record: true, memory: true })).status).toBe(410);
  expect((await call("POST", "/v1/pairings/ZZZZZZZZ/claim", undefined, { record: true, memory: true })).status).toBe(404);
});

test("claim records consents; unpair kills phone token but keeps memory; re-pair replaces old phone", async () => {
  const { call, car, pair, newCode, seedMemory, memory } = boot();
  const a = await car("install-aaaa1");
  const p1 = await pair(a, false);
  const cons: { consents: { type: string; granted: boolean }[] } = await (await call("GET", "/v1/consents", p1.phoneToken)).json();
  expect(cons.consents.find((c) => c.type === "record")?.granted).toBe(true);
  expect(cons.consents.find((c) => c.type === "memory")?.granted).toBe(false);
  seedMemory("install-aaaa1", 2);
  const code = await newCode(a);
  const second: { phoneToken: string } = await (await call("POST", `/v1/pairings/${code}/claim`, undefined, { record: true, memory: true })).json();
  expect((await call("GET", "/v1/settings", p1.phoneToken)).status).toBe(401);
  expect((await call("GET", "/v1/settings", second.phoneToken)).status).toBe(200);
  expect((await call("DELETE", "/v1/pairings/current", a)).status).toBe(204);
  expect((await call("GET", "/v1/settings", second.phoneToken)).status).toBe(401);
  expect((await memory(a)).items.length).toBe(2);
});

test("public pairing lookup is rate limited per IP", async () => {
  const { call } = boot(3);
  const codes = ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "DDDDDDDD"];
  const statuses: number[] = [];
  for (const c of codes) statuses.push((await call("GET", `/v1/pairings/${c}`)).status);
  expect(statuses).toEqual([200, 200, 200, 429]);
});

test("settings PATCH pushes to the hub and validates input", async () => {
  const { call, car, pushed } = boot();
  const a = await car("install-aaaa1");
  expect(await (await call("GET", "/v1/settings", a)).json()).toEqual({ proactive: "normal", memoryEnabled: true, speech: "banmal", nickname: null });
  expect((await call("PATCH", "/v1/settings", a, { proactive: "high" })).status).toBe(200);
  expect(pushed.length).toBe(1);
  expect((await call("PATCH", "/v1/settings", a, { proactive: "loud" })).status).toBe(400);
  expect((await call("PATCH", "/v1/settings", a, { nickname: "가".repeat(21) })).status).toBe(400);
  expect((await call("PATCH", "/v1/settings", a, { bogus: 1 })).status).toBe(400);
  expect(pushed.length).toBe(1);
});

test("vehicle events: 202 and coordinate keys dropped", async () => {
  const { call, car, dbPath } = boot();
  const a = await car("install-aaaa1");
  const res = await call("POST", "/v1/vehicle-events", a, [{ at: "2026-11-15T01:00:00Z", ctx: { gear: "D", speedKmh: 40, lat: 37.5, gpsLng: 127.1, location: "x" } }]);
  expect(res.status).toBe(202);
  const db = new Database(dbPath);
  const row = db.query("SELECT ctx FROM vehicle_events").get() as { ctx: string } | null;
  db.close();
  expect(JSON.parse(row?.ctx ?? "{}")).toEqual({ gear: "D", speedKmh: 40 });
  expect((await call("POST", "/v1/vehicle-events", a, [{ at: "nope", ctx: {} }])).status).toBe(400);
  expect((await call("POST", "/v1/vehicle-events", a, { at: "x" })).status).toBe(400);
});
