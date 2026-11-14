import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadGuardConfig } from "../src/auth";
import { Observability } from "../src/observe";
import { createServer, type RunningServer, type ServerOptions } from "../src/server";
import type { TtsProvider } from "../src/tts";

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 };
const sse = readFileSync(`${import.meta.dir}/fixtures/openai.sse`, "utf8");

let servers: RunningServer[] = [];
afterEach(() => {
  for (const s of servers) void s.stop(true);
  servers = [];
});

interface LlmSeen { calls: number; system: string[] }
interface Frame { type: string; turnId?: string; text?: string; code?: string; audio?: unknown }
interface Started { port: number | undefined; base: string; seen: LlmSeen }

function start(guard: Partial<ServerOptions["guard"]> = {}, dbPath = ":memory:", hangLlm = false, tts: TtsProvider | null = null, body = sse): Started {
  const seen: LlmSeen = { calls: 0, system: [] };
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    seen.calls++;
    seen.system.push(String(init.body));
    if (hangLlm) await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const s = createServer({
    port: 0,
    hostname: "127.0.0.1",
    talk,
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 100, ...guard },
    observer: new Observability(() => {}),
    dbPath,
    tts,
    fetchImpl,
  });
  servers.push(s);
  return { port: s.port, base: `http://127.0.0.1:${s.port}`, seen };
}

const post = (url: string, headers: Record<string, string>, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** `grant: false` leaves the car without consents (the state before C1). */
async function registerAndSession(base: string, installId = "install-0001", grant = true) {
  const reg = await post(`${base}/v1/cars/register`, { "X-Provision-Secret": SECRET }, { installId });
  const { carToken } = (await reg.json()) as { carToken: string };
  if (grant) for (const type of ["record", "external_ai"]) await post(`${base}/v1/consents`, { Authorization: `Bearer ${carToken}` }, { type, version: "1", granted: true, channel: "car" });
  const ses = await post(`${base}/v1/sessions`, { Authorization: `Bearer ${carToken}` });
  return { carToken, ses, ...((await ses.json()) as { wsTicket: string; sessionId: string }) };
}

class Client {
  frames: Frame[] = [];
  binary: ArrayBuffer[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.frames.push(JSON.parse(e.data));
      else this.binary.push(e.data as ArrayBuffer);
      this.waiters.splice(0).forEach((w) => w());
    };
  }
  static async open(port: number | undefined, ticket: string) {
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/talk?ticket=${ticket}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
    return new Client(await promise);
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  async until(pred: (f: Frame[]) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred(this.frames)) {
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
}

const upgradeHeaders = { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" };

describe("register / sessions", () => {
  test("wrong or missing provision secret -> 403", async () => {
    const { base } = start();
    expect((await post(`${base}/v1/cars/register`, { "X-Provision-Secret": "nope" }, { installId: "install-0001" })).status).toBe(403);
    expect((await post(`${base}/v1/cars/register`, {}, { installId: "install-0001" })).status).toBe(403);
  });
  test("bad installId -> 400", async () => {
    const { base } = start();
    expect((await post(`${base}/v1/cars/register`, { "X-Provision-Secret": SECRET }, { installId: "x" })).status).toBe(400);
  });
  test("sessions need a valid carToken", async () => {
    const { base } = start();
    expect((await post(`${base}/v1/sessions`, {})).status).toBe(401);
    expect((await post(`${base}/v1/sessions`, { Authorization: "Bearer nope" })).status).toBe(401);
    const r = await registerAndSession(base);
    expect(r.ses.status).toBe(200);
    expect(r.wsTicket.length).toBeGreaterThan(20);
  });
  test("re-registering the same installId revokes the old carToken", async () => {
    const { base } = start();
    const a = await registerAndSession(base);
    await registerAndSession(base);
    expect((await post(`${base}/v1/sessions`, { Authorization: `Bearer ${a.carToken}` })).status).toBe(401);
  });
  test("registration survives a restart (sqlite file) and stores only a hash", async () => {
    const db = `${mkdtempSync(`${tmpdir()}/companion-`)}/data/companion.sqlite`;
    const first = start({}, db);
    const { carToken } = await registerAndSession(first.base);
    await servers.pop()!.stop(true);
    const second = start({}, db);
    expect((await post(`${second.base}/v1/sessions`, { Authorization: `Bearer ${carToken}` })).status).toBe(200);
    const rows = new Database(db, { readonly: true }).query("SELECT token_hash FROM cars").all() as { token_hash: string }[];
    expect(rows.some((r) => r.token_hash === carToken)).toBe(false);
  });
});

describe("ws upgrade", () => {
  test("missing, invalid and reused tickets -> 401", async () => {
    const { base, port } = start();
    const url = (q: string) => fetch(`${base}/v1/talk${q}`, { headers: upgradeHeaders });
    expect((await url("")).status).toBe(401);
    expect((await url("?ticket=bogus")).status).toBe(401);
    const { wsTicket } = await registerAndSession(base);
    (await Client.open(port, wsTicket)).ws.close();
    expect((await url(`?ticket=${wsTicket}`)).status).toBe(401);
  });
  test("a fixed shared token is no longer accepted", async () => {
    const { base } = start();
    const r = await fetch(`${base}/v1/talk`, { headers: { ...upgradeHeaders, Authorization: "Bearer anything", "Sec-WebSocket-Protocol": "companion.anything" } });
    expect(r.status).toBe(401);
  });
  test("expired ticket -> 401", async () => {
    const t = { now: 1_000_000 };
    const s = createServer({
      port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:",
      guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 100 },
      clock: { now: () => t.now, setTimeout: () => ({ id: 0 }), clearTimeout: () => {} },
    });
    servers.push(s);
    const base = `http://127.0.0.1:${s.port}`;
    const { wsTicket } = await registerAndSession(base);
    t.now += 61_000;
    expect((await fetch(`${base}/v1/talk?ticket=${wsTicket}`, { headers: upgradeHeaders })).status).toBe(401);
  });
  test("upgrade attempts are limited per client ip, only trusting proxy headers when enabled", async () => {
    const plain = start({ upgradesPerMin: 2 });
    const hit = (b: string, ip: string) => fetch(`${b}/v1/talk`, { headers: { ...upgradeHeaders, "CF-Connecting-IP": ip } });
    for (let i = 0; i < 2; i++) expect((await hit(plain.base, `9.9.9.${i}`)).status).toBe(401);
    expect((await hit(plain.base, "9.9.9.9")).status).toBe(429);
    const proxied = start({ upgradesPerMin: 1, trustProxy: true });
    expect((await hit(proxied.base, "1.1.1.1")).status).toBe(401);
    expect((await hit(proxied.base, "2.2.2.2")).status).toBe(401);
    expect((await hit(proxied.base, "1.1.1.1")).status).toBe(429);
  });
});

describe("turns", () => {
  async function connect(s: Started) {
    const { wsTicket } = await registerAndSession(s.base);
    const c = await Client.open(s.port, wsTicket);
    c.send({ type: "hello", v: 1, appVersion: "t" });
    return c;
  }

  test("normal round trip: reply.start, deltas, reply.end", async () => {
    const s = start();
    const c = await connect(s);
    c.send({ type: "turn.start", turnId: "t1", trigger: "ptt" });
    c.send({ type: "text", turnId: "t1", text: "안녕" });
    c.send({ type: "turn.end", turnId: "t1" });
    await c.until((f) => f.some((x) => x.type === "reply.end"));
    expect(c.frames[0]).toEqual({ type: "reply.start", turnId: "t1", audio: "none" });
    expect(c.frames.some((f) => f.type === "reply.delta" && f.turnId === "t1")).toBe(true);
    const end = c.frames.at(-1);
    expect(end?.type).toBe("reply.end");
    expect(end?.text?.length).toBeGreaterThan(0);
    expect(s.seen.calls).toBe(1);
    c.ws.close();
  });

  test("turn.cancel stops the turn: no reply frames at all", async () => {
    const s = start({}, ":memory:", true);
    const c = await connect(s);
    c.send({ type: "turn.start", turnId: "t1", trigger: "ptt" });
    c.send({ type: "text", turnId: "t1", text: "안녕" });
    c.send({ type: "turn.end", turnId: "t1" });
    await c.until(() => s.seen.calls === 1);
    c.send({ type: "turn.cancel", turnId: "t1" });
    // 부정 단언(아무 프레임도 오지 않음)은 실제 시간이 지나야만 확인할 수 있다.
    await Bun.sleep(300);
    expect(c.frames.filter((f) => f.type === "reply.delta" || f.type === "reply.end" || f.type === "error")).toEqual([]);
    expect(c.binary.length).toBe(0);
    c.ws.close();
  });

  test("turn.cancel before turn.end -> no LLM call and no reply frames", async () => {
    const s = start();
    const c = await connect(s);
    c.send({ type: "turn.start", turnId: "t1", trigger: "ptt" });
    c.send({ type: "text", turnId: "t1", text: "안녕" });
    c.send({ type: "turn.cancel", turnId: "t1" });
    c.send({ type: "turn.end", turnId: "t1" });
    await c.until((f) => f.length >= 1);
    expect(c.frames).toEqual([{ type: "error", code: "turn_unknown", turnId: "t1" }]);
    expect(s.seen.calls).toBe(0);
    c.ws.close();
  });

  test("ctx coordinate keys are dropped and the turn continues", async () => {
    const s = start();
    const c = await connect(s);
    c.send({ type: "turn.start", turnId: "t1", trigger: "ptt" });
    c.send({ type: "ctx", turnId: "t1", ctx: { gear: "P", lat: 37.5, longitude: 127.1, location: "x", rangeKm: 90 } });
    c.send({ type: "text", turnId: "t1", text: "안녕" });
    c.send({ type: "turn.end", turnId: "t1" });
    await c.until((f) => f.some((x) => x.type === "reply.end"));
    const body = s.seen.system[0]!;
    expect(body).toContain("gear=P");
    expect(body).toContain("rangeKm=90");
    expect(body).not.toMatch(/37\.5|127\.1|lat=|longitude|location/);
    c.ws.close();
  });

  test("frames before hello are refused; app binary closes the socket", async () => {
    const s = start();
    const { wsTicket } = await registerAndSession(s.base);
    const c = await Client.open(s.port, wsTicket);
    c.send({ type: "turn.start", turnId: "t1", trigger: "ptt" });
    await c.until((f) => f.length === 1);
    expect(c.frames[0]).toEqual({ type: "error", code: "hello_required" });
    const closed = new Promise<number>((r) => (c.ws.onclose = (e) => r(e.code)));
    c.ws.send(new Uint8Array([1, 2, 3]));
    expect(await closed).toBe(1003);
  });

  test("over the per-minute limit -> rate_limited and the provider is not called again", async () => {
    const s = start({ turnsPerMin: 1 });
    const c = await connect(s);
    for (const id of ["t1", "t2"]) {
      c.send({ type: "turn.start", turnId: id, trigger: "ptt" });
      c.send({ type: "text", turnId: id, text: "안녕" });
      c.send({ type: "turn.end", turnId: id });
      await c.until((f) => f.some((x) => x.turnId === id && (x.type === "reply.end" || x.type === "error")));
    }
    expect(c.frames.at(-1)).toEqual({ type: "error", code: "rate_limited", turnId: "t2" });
    expect(s.seen.calls).toBe(1);
    c.ws.close();
  });
});

describe("healthz", () => {
  test("loopback sees detail, proxied requests only see ok", async () => {
    const { base } = start();
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: true, provider: "openai-compatible", model: "chat-fast" });
    expect(await (await fetch(`${base}/healthz`, { headers: { "CF-Connecting-IP": "8.8.8.8" } })).json()).toEqual({ ok: true });
  });
});

describe("guard config", () => {
  test("refuses to start without a provision secret unless explicitly allowed", () => {
    expect(() => loadGuardConfig({}, {})).toThrow("COMPANION_PROVISION_SECRET");
    expect(loadGuardConfig({ COMPANION_ALLOW_NO_AUTH: "1" }, {}).provisionSecret).toBeUndefined();
  });
});
