import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadGuardConfig } from "../src/auth";
import { Observability } from "../src/observe";
import { createServer, type RunningServer, type ServerOptions } from "../src/server";

const TOKEN = "t0k3n-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 };
const sse = readFileSync(`${import.meta.dir}/fixtures/openai.sse`, "utf8");

let servers: RunningServer[] = [];
afterEach(() => {
  for (const s of servers) void s.stop(true);
  servers = [];
});

function start(guard: Partial<ServerOptions["guard"]> = {}) {
  let llmCalls = 0;
  const fetchImpl = (async () => {
    llmCalls++;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const s = createServer({
    port: 0,
    hostname: "127.0.0.1",
    talk,
    guard: { token: TOKEN, trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, ...guard },
    observer: new Observability(() => {}),
    fetchImpl,
  });
  servers.push(s);
  return { port: s.port, llmCalls: () => llmCalls };
}

const upgradeHeaders = { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" };
const raw = (port: number | undefined, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/talk`, { headers: { ...upgradeHeaders, ...headers } });

function openWs(port: number | undefined, init: ConstructorParameters<typeof WebSocket>[1]) {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/talk`, init);
  ws.onopen = () => resolve(ws);
  ws.onerror = () => reject(new Error("ws error"));
  return promise;
}
function nextMessage(ws: WebSocket) {
  const { promise, resolve } = Promise.withResolvers<any>();
  ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
  return promise;
}

describe("upgrade auth", () => {
  test("no token -> 401", async () => {
    expect((await raw(start().port)).status).toBe(401);
  });
  test("wrong bearer and wrong subprotocol -> 401", async () => {
    const { port } = start();
    expect((await raw(port, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await raw(port, { "Sec-WebSocket-Protocol": "companion.nope" })).status).toBe(401);
    expect((await raw(port, { "Sec-WebSocket-Protocol": TOKEN })).status).toBe(401);
  });
  test("good bearer upgrades", async () => {
    const ws = await openWs(start().port, { headers: { Authorization: `Bearer ${TOKEN}` } } as never);
    ws.close();
  });
  test("good subprotocol upgrades and is echoed", async () => {
    const ws = await openWs(start().port, [`companion.${TOKEN}`] as never);
    expect(ws.protocol).toBe(`companion.${TOKEN}`);
    ws.close();
  });
  test("upgrade attempts are limited per client ip, only trusting proxy headers when enabled", async () => {
    const plain = start({ upgradesPerMin: 2 });
    for (let i = 0; i < 2; i++) expect((await raw(plain.port, { "CF-Connecting-IP": `9.9.9.${i}` })).status).toBe(401);
    expect((await raw(plain.port, { "CF-Connecting-IP": "9.9.9.9" })).status).toBe(429);
    const proxied = start({ upgradesPerMin: 1, trustProxy: true });
    expect((await raw(proxied.port, { "CF-Connecting-IP": "1.1.1.1" })).status).toBe(401);
    expect((await raw(proxied.port, { "CF-Connecting-IP": "2.2.2.2" })).status).toBe(401);
    expect((await raw(proxied.port, { "CF-Connecting-IP": "1.1.1.1" })).status).toBe(429);
  });
});

describe("turn rate limit", () => {
  test("over the per-minute limit -> rate_limited and the provider is not called", async () => {
    const s = start({ turnsPerMin: 1 });
    const ws = await openWs(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } } as never);
    const turn = JSON.stringify({ type: "turn", text: "안녕" });
    const done = new Promise<void>((resolve) => {
      ws.onmessage = (e) => String(e.data).includes("reply.end") && resolve();
    });
    ws.send(turn);
    await done;
    expect(s.llmCalls()).toBe(1);
    const next = nextMessage(ws);
    ws.send(turn);
    expect(await next).toEqual({ type: "error", code: "rate_limited" });
    expect(s.llmCalls()).toBe(1);
    ws.close();
  });
});

describe("healthz", () => {
  test("loopback sees detail, proxied requests only see ok", async () => {
    const { port } = start();
    const local = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(local).toMatchObject({ ok: true, provider: "openai-compatible", model: "chat-fast" });
    const viaProxy = await (await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { "CF-Connecting-IP": "8.8.8.8" } })).json();
    expect(viaProxy).toEqual({ ok: true });
  });
});

describe("guard config", () => {
  test("refuses to start without a token unless explicitly allowed", () => {
    expect(() => loadGuardConfig({}, {})).toThrow("COMPANION_CLIENT_TOKEN");
    expect(loadGuardConfig({ COMPANION_ALLOW_NO_AUTH: "1" }, {}).token).toBeUndefined();
  });
});
