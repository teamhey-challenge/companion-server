import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Clock, TimerHandle } from "../src/clock";
import { Observability } from "../src/observe";
import { createServer, type RunningServer } from "../src/server";
import { ApiStore } from "../src/api-store";

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
  const pairingPushed: [string, string][] = [];
  const dbPath = `${mkdtempSync(`${tmpdir()}/api-`)}/c.db`;
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath, clock, publicPerMin,
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 1000 },
    hub: { pushSettings: (id, st) => pushed.push([id, st]), pushPairing: (id, st) => pairingPushed.push([id, st]) },
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
  return { clock, call, car, newCode, pair, pushed, pairingPushed, seedMemory, memory, current, dbPath };
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
  expect((await call("GET", "/v1/pairings/current", pa.phoneToken)).status).toBe(403);
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

test("withdrawing record consent also deletes stored vehicle events and the nickname", async () => {
  const { call, car, dbPath } = boot();
  const a = await car("install-aaaa1");
  await call("POST", "/v1/consents", a, { type: "record", version: "1", granted: true, channel: "car" });
  await call("POST", "/v1/vehicle-events", a, [{ at: "2026-11-15T01:00:00Z", ctx: { gear: "D", speedKmh: 40 } }]);
  await call("PATCH", "/v1/settings", a, { nickname: "민수" });
  const count = () => {
    const db = new Database(dbPath);
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vehicle_events WHERE install_id = 'install-aaaa1'").get();
    db.close();
    return row?.n ?? -1;
  };
  expect(count()).toBe(1);
  expect((await call("DELETE", "/v1/consents/record", a)).status).toBe(204);
  expect(count()).toBe(0);
  expect(await (await call("GET", "/v1/settings", a)).json()).toMatchObject({ nickname: null });
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

test("phone token can unpair itself only: car goes to none, token 401, memory kept, other phone untouched", async () => {
  const { call, car, pair, seedMemory, memory, current } = boot();
  const a = await car("install-aaaa1");
  const b = await car("install-bbbb1");
  const pa = await pair(a);
  const pb = await pair(b);
  seedMemory("install-aaaa1", 2);
  expect((await call("GET", "/v1/pairings/current", pa.phoneToken)).status).toBe(403);
  expect((await call("DELETE", "/v1/pairings/current", pa.phoneToken)).status).toBe(204);
  expect((await call("GET", "/v1/settings", pa.phoneToken)).status).toBe(401);
  expect((await call("DELETE", "/v1/pairings/current", pa.phoneToken)).status).toBe(401);
  expect((await current(a)).status).toBe("none");
  expect((await memory(a)).items.length).toBe(2);
  expect((await current(b)).status).toBe("claimed");
  expect((await call("GET", "/v1/settings", pb.phoneToken)).status).toBe(200);
  expect((await call("DELETE", "/v1/pairings/current", b)).status).toBe(204);
  expect((await call("GET", "/v1/settings", pb.phoneToken)).status).toBe(401);
});

test("unpair by phone or car pushes a pairing(none) frame for that car only (PLEOS-158)", async () => {
  const { call, car, pair, pairingPushed } = boot();
  const a = await car("install-aaaa1");
  const b = await car("install-bbbb1");
  const pa = await pair(a);
  const pb = await pair(b);
  expect((await call("DELETE", "/v1/pairings/current", pa.phoneToken)).status).toBe(204);
  expect(pairingPushed).toEqual([["install-aaaa1", "none"]]);
  expect((await call("DELETE", "/v1/pairings/current", b)).status).toBe(204);
  expect(pairingPushed).toEqual([["install-aaaa1", "none"], ["install-bbbb1", "none"]]);
  // a rejected call (token already revoked) pushes nothing
  expect((await call("DELETE", "/v1/pairings/current", pb.phoneToken)).status).toBe(401);
  expect(pairingPushed.length).toBe(2);
});

test("re-pair with the memory box unchecked keeps memory and F2 state, only future consent changes (PLEOS-136)", async () => {
  const { call, car, pair, newCode, seedMemory, memory } = boot();
  const a = await car("install-aaaa1");
  await pair(a, true);
  seedMemory("install-aaaa1", 3);
  const code = await newCode(a);
  const r = await call("POST", `/v1/pairings/${code}/claim`, undefined, { record: true, memory: false });
  const { phoneToken } = (await r.json()) as { phoneToken: string };
  expect((await memory(a)).items.length).toBe(3);
  const cons: { consents: { type: string; granted: boolean }[] } = await (await call("GET", "/v1/consents", phoneToken)).json();
  expect(cons.consents.find((c) => c.type === "memory")?.granted).toBe(false);
  expect(await (await call("GET", "/v1/settings", phoneToken)).json()).toMatchObject({ memoryEnabled: false });
  // an explicit withdrawal still deletes
  expect((await call("DELETE", "/v1/consents/memory", a)).status).toBe(204);
  expect((await memory(a)).items.length).toBe(0);
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
  expect(await (await call("GET", "/v1/settings", a)).json()).toEqual({ proactive: "normal", memoryEnabled: true, speech: "banmal", nickname: null, bodyColor: null, hat: 0, neck: 0 });
  expect((await call("PATCH", "/v1/settings", a, { proactive: "high" })).status).toBe(200);
  expect(pushed.length).toBe(1);
  expect((await call("PATCH", "/v1/settings", a, { proactive: "loud" })).status).toBe(400);
  expect((await call("PATCH", "/v1/settings", a, { nickname: "가".repeat(21) })).status).toBe(400);
  expect((await call("PATCH", "/v1/settings", a, { bogus: 1 })).status).toBe(400);
  expect(pushed.length).toBe(1);
});

test("look settings (D-41): validated ranges, null bodyColor follows the theme, phone can read but not write", async () => {
  const { call, car, pair, pushed } = boot();
  const a = await car("install-aaaa1");
  const ok = await call("PATCH", "/v1/settings", a, { bodyColor: 1, hat: 2, neck: 1 });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ bodyColor: 1, hat: 2, neck: 1 });
  expect(pushed.length).toBe(1);
  for (const bad of [{ hat: 3 }, { hat: -1 }, { hat: 1.5 }, { hat: "1" }, { hat: null }, { neck: 2 }, { bodyColor: 2 }, { bodyColor: "0" }]) {
    expect((await call("PATCH", "/v1/settings", a, bad)).status).toBe(400);
  }
  expect(pushed.length).toBe(1);
  // other settings keep the look; bodyColor null goes back to following the theme
  await call("PATCH", "/v1/settings", a, { proactive: "low" });
  expect(await (await call("GET", "/v1/settings", a)).json()).toMatchObject({ bodyColor: 1, hat: 2, neck: 1, proactive: "low" });
  await call("PATCH", "/v1/settings", a, { bodyColor: null });
  expect(await (await call("GET", "/v1/settings", a)).json()).toMatchObject({ bodyColor: null, hat: 2, neck: 1 });
  const p = (await pair(a)).phoneToken;
  expect(await (await call("GET", "/v1/settings", p)).json()).toMatchObject({ hat: 2, neck: 1 });
  expect((await call("PATCH", "/v1/settings", p, { hat: 0 })).status).toBe(403);
});

test("memory consent drives settings.memoryEnabled (PLEOS-129)", async () => {
  const { call, car, pair } = boot();
  const a = await car("install-aaaa1");
  const enabled = async (tok: string) => {
    const s: { memoryEnabled: boolean } = await (await call("GET", "/v1/settings", tok)).json();
    return s.memoryEnabled;
  };
  // 폰 claim memory=false → 꺼짐, 이후 폰이 memory 동의를 켜면 켜짐
  const p = await pair(a, false);
  expect(await enabled(a)).toBe(false);
  const grant = (tok: string, channel: string) => call("POST", "/v1/consents", tok, { type: "memory", version: "v1", granted: true, channel });
  expect((await grant(p.phoneToken, "phone")).status).toBe(200);
  expect(await enabled(a)).toBe(true);
  // 동의 철회 → 꺼짐
  expect((await call("DELETE", "/v1/consents/memory", a)).status).toBe(204);
  expect(await enabled(a)).toBe(false);
  // 재동의 → 켜짐
  expect((await grant(a, "car")).status).toBe(200);
  expect(await enabled(a)).toBe(true);
  // 사용자가 설정에서 끔 → 같은 동의를 다시 보내도 꺼진 채 유지
  expect((await call("PATCH", "/v1/settings", a, { memoryEnabled: false })).status).toBe(200);
  expect((await grant(a, "car")).status).toBe(200);
  expect(await enabled(a)).toBe(false);
  // 철회 후 재동의하면 다시 켜짐
  await call("DELETE", "/v1/consents/memory", a);
  await grant(a, "car");
  expect(await enabled(a)).toBe(true);
  // 새 차에서 폰 claim memory=true → 켜짐
  const b = await car("install-bbbb1");
  await pair(b, true);
  expect(await enabled(b)).toBe(true);
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

test("PLEOS-174: same sentence is not written twice, across kinds or with punctuation/space differences", () => {
  const api = new ApiStore(new Database(":memory:"), new FakeClock());
  const first = api.addMemory("i1", "summary", "퇴근길에는 조용한 대화를 좋아해요.");
  const again = api.addMemory("i1", "fact", "  퇴근길에는  조용한 대화를 좋아해요 ");
  expect(again.id).toBe(first.id);
  expect(api.listMemory("i1", 10).length).toBe(1);
  // 다른 차에는 따로 쓴다
  api.addMemory("i2", "fact", "퇴근길에는 조용한 대화를 좋아해요.");
  expect(api.listMemory("i2", 10).length).toBe(1);
  expect(api.listMemory("i1", 10).length).toBe(1);
});

test("PLEOS-174: existing duplicate rows are hidden in the list (newest kept, rows untouched) and deleting the shown item removes the twin", async () => {
  const { call, car, dbPath } = boot();
  const a = await car("install-aaaa1");
  const b = await car("install-bbbb1");
  const db = new Database(dbPath);
  const ins = (id: string, inst: string, kind: string, text: string, at: number) =>
    db.query("INSERT INTO memory (id, install_id, kind, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(id, inst, kind, text, at);
  ins("old", "install-aaaa1", "summary", "퇴근길에는 조용한 대화를 좋아해요.", 1);
  ins("other", "install-aaaa1", "fact", "내일 면접이 있다", 2);
  ins("new", "install-aaaa1", "fact", "퇴근길에는 조용한 대화를 좋아해요", 3);
  ins("b-same", "install-bbbb1", "fact", "퇴근길에는 조용한 대화를 좋아해요.", 4);
  const count = (inst: string) => (db.query("SELECT COUNT(*) AS n FROM memory WHERE install_id = ?1").get(inst) as { n: number }).n;
  expect((await (await call("GET", "/v1/memory?limit=100", a)).json() as MemPage).items.map((i) => i.id)).toEqual(["new", "other"]);
  // 목록 쪽 중복 제거는 행을 지우지 않는다
  expect(count("install-aaaa1")).toBe(3);
  // 쪽 나누기도 중복을 건너뛴다
  const p1 = (await (await call("GET", "/v1/memory?limit=1", a)).json()) as MemPage;
  expect(p1.items.map((i) => i.id)).toEqual(["new"]);
  const p2 = (await (await call("GET", `/v1/memory?limit=1&cursor=${p1.nextCursor}`, a)).json()) as MemPage;
  expect(p2.items.map((i) => i.id)).toEqual(["other"]);
  expect(p2.nextCursor).toBeNull();
  // 보이는 항목을 지우면 숨은 쌍둥이도 사라져 다시 나타나지 않는다. 다른 차는 그대로.
  expect((await call("DELETE", "/v1/memory/new", a)).status).toBe(204);
  expect((await memory(a)).items.map((i) => i.id)).toEqual(["other"]);
  expect(count("install-aaaa1")).toBe(1);
  expect(count("install-bbbb1")).toBe(1);
  db.close();
  async function memory(tok: string): Promise<MemPage> { return (await call("GET", "/v1/memory?limit=100", tok)).json(); }
  void b;
});
