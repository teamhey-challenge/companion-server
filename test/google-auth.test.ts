import { afterEach, describe, expect, test } from "bun:test";
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
const CLIENT = "web-client.apps.googleusercontent.com";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 };
let servers: RunningServer[] = [];
afterEach(() => { for (const s of servers) void s.stop(true); servers = []; });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const keyPair = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

async function sign(priv: CryptoKey, kid: string, payload: Record<string, unknown>, alg = "RS256") {
  const head = `${b64({ alg, kid, typ: "JWT" })}.${b64(payload)}`;
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(head))).toString("base64url");
  return `${head}.${sig}`;
}

async function boot(opts: { configured?: boolean; publicPerMin?: number } = {}) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const kp = await keyPair();
  const other = await keyPair();
  const jwk = async (pub: CryptoKey, kid: string) => ({ ...(await crypto.subtle.exportKey("jwk", pub)), kid, alg: "RS256", use: "sig" });
  const served = { keys: [await jwk(kp.publicKey, "k1")] as unknown[], fetches: 0 };
  const googleFetch = (async () => {
    served.fetches++;
    return new Response(JSON.stringify({ keys: served.keys }), { headers: { "cache-control": "public, max-age=3600" } });
  }) as unknown as typeof fetch;
  const dbPath = `${mkdtempSync(`${tmpdir()}/gauth-`)}/c.db`;
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability((l) => logs.push(String(l))), dbPath, clock, publicPerMin: opts.publicPerMin ?? 100,
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 1000 },
    googleClientId: opts.configured === false ? undefined : CLIENT, googleFetch,
  });
  servers.push(s);
  const base = `http://127.0.0.1:${s.port}`;
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const claims = (sub: string, over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: CLIENT, sub, given_name: "지은", exp: clock.t / 1000 + 600, ...over });
  const login = async (sub: string, over: Record<string, unknown> = {}, kid = "k1", priv = kp.privateKey) => {
    const idToken = await sign(priv, kid, claims(sub, over));
    const res = await call("POST", "/v1/auth/google", undefined, { idToken });
    return { res, idToken, body: (await res.clone().json()) as { phoneToken: string; accountId: string; displayName: string; linkedCar: boolean; isNew: boolean; error?: string; code?: string } };
  };
  const car = async (installId: string) => {
    const r = await fetch(`${base}/v1/cars/register`, { method: "POST", headers: { "x-provision-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify({ installId }) });
    return ((await r.json()) as { carToken: string }).carToken;
  };
  const claim = async (carToken: string, phoneToken?: string) => {
    const { pairCode } = (await (await call("POST", "/v1/pairings", carToken)).json()) as { pairCode: string };
    const res = await call("POST", `/v1/pairings/${pairCode}/claim`, phoneToken, { record: true, memory: true });
    return { res, body: (await res.clone().json()) as { phoneToken?: string; code?: string } };
  };
  return { clock, logs, served, call, login, car, claim, jwk, kp, other };
}

describe("POST /v1/auth/google", () => {
  test("valid token creates a phone-only account named by given_name; logging in again returns the same one", async () => {
    const e = await boot();
    const a = await e.login("sub-aaa");
    expect(a.res.status).toBe(200);
    expect(a.body).toMatchObject({ displayName: "지은", linkedCar: false, isNew: true });
    expect(a.body.accountId).toMatch(/^ph_/);
    expect(((await (await e.call("GET", "/v1/settings", a.body.phoneToken)).json()) as { displayName: string }).displayName).toBe("지은");
    const b = await e.login("sub-aaa");
    expect(b.body).toMatchObject({ accountId: a.body.accountId, isNew: false, linkedCar: false });
    expect((await e.call("GET", "/v1/settings", b.body.phoneToken)).status).toBe(200);
    expect(e.served.fetches).toBe(1);
  });

  test("rejects wrong aud, wrong iss, expired, bad signature, wrong alg and garbage", async () => {
    const e = await boot();
    expect((await e.login("s", { aud: "someone-else" })).res.status).toBe(401);
    expect((await e.login("s", { iss: "https://evil.example" })).res.status).toBe(401);
    expect((await e.login("s", { exp: e.clock.t / 1000 - 1 })).res.status).toBe(401);
    expect((await e.login("s", {}, "k1", e.other.privateKey)).res.status).toBe(401);
    const hs = await e.call("POST", "/v1/auth/google", undefined, { idToken: `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.AAAA` });
    expect(hs.status).toBe(401);
    expect((await e.call("POST", "/v1/auth/google", undefined, { idToken: "not-a-jwt" })).status).toBe(401);
    expect((await e.call("POST", "/v1/auth/google", undefined, {})).status).toBe(400);
    expect((await e.login("ok-sub", { aud: [CLIENT, "x"] })).res.status).toBe(200);
  });

  test("unknown kid refetches the JWKS once, then accepts the rotated key", async () => {
    const e = await boot();
    expect((await e.login("s1")).res.status).toBe(200);
    const rotated = await keyPair();
    e.served.keys.push(await e.jwk(rotated.publicKey, "k2"));
    e.clock.t += 31_000;
    const r = await e.login("s2", {}, "k2", rotated.privateKey);
    expect(r.res.status).toBe(200);
    expect(e.served.fetches).toBe(2);
    // a kid Google never publishes does not hammer the endpoint
    e.clock.t += 31_000;
    expect((await e.login("s3", {}, "k9")).res.status).toBe(401);
    expect((await e.login("s3", {}, "k9")).res.status).toBe(401);
    expect(e.served.fetches).toBe(3);
  });

  test("503 google_login_unconfigured when GOOGLE_WEB_CLIENT_ID is unset; rest of the server works", async () => {
    const e = await boot({ configured: false });
    const r = await e.call("POST", "/v1/auth/google", undefined, { idToken: "x" });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe("google_login_unconfigured");
    expect((await e.call("POST", "/v1/phones/register", undefined, { displayName: "a" })).status).toBe(200);
  });

  test("is IP rate limited", async () => {
    const e = await boot({ publicPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await e.call("POST", "/v1/auth/google", undefined, { idToken: "x" })).status);
    expect(codes).toContain(429);
  });
});

describe("linking a car", () => {
  test("claim with a Google phone token binds; re-login returns the car account; unpair unbinds", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const g = await e.login("sub-aaa");
    const c = await e.claim(carToken, g.body.phoneToken);
    expect(c.res.status).toBe(200);
    const again = await e.login("sub-aaa");
    expect(again.body).toMatchObject({ accountId: "install-aaaa1", linkedCar: true, isNew: false });
    // the new token reads the car's pairing; the claim token still maps to the same car
    expect(((await (await e.call("GET", "/v1/settings", again.body.phoneToken)).json()) as { speech: string }).speech).toBeDefined();
    expect((await e.call("GET", "/v1/pairings/current", carToken)).status).toBe(200);

    expect((await e.call("DELETE", "/v1/pairings/current", again.body.phoneToken)).status).toBe(204);
    const after = await e.login("sub-aaa");
    expect(after.body).toMatchObject({ accountId: g.body.accountId, linkedCar: false, isNew: false });
  });

  test("a second Google account claiming a linked car gets 409; the first stays linked", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const a = await e.login("sub-aaa");
    const b = await e.login("sub-bbb");
    expect((await e.claim(carToken, a.body.phoneToken)).res.status).toBe(200);
    const second = await e.claim(carToken, b.body.phoneToken);
    expect(second.res.status).toBe(409);
    expect(second.body.code).toBe("car_linked_to_other_account");
    expect((await e.login("sub-aaa")).body.linkedCar).toBe(true);
    expect((await e.login("sub-bbb")).body.linkedCar).toBe(false);
  });

  test("the same Google account re-claiming its own car is fine; a name-only claim of a linked car clears the binding", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const a = await e.login("sub-aaa");
    expect((await e.claim(carToken, a.body.phoneToken)).res.status).toBe(200);
    expect((await e.claim(carToken, a.body.phoneToken)).res.status).toBe(200);
    expect((await e.claim(carToken)).res.status).toBe(200);
    expect((await e.login("sub-aaa")).body.linkedCar).toBe(false);
  });

  test("a Google account can bind only one car", async () => {
    const e = await boot();
    const a = await e.login("sub-aaa");
    expect((await e.claim(await e.car("install-aaaa1"), a.body.phoneToken)).res.status).toBe(200);
    const g2 = await e.login("sub-aaa");
    const r = await e.claim(await e.car("install-bbbb1"), g2.body.phoneToken);
    expect(r.res.status).toBe(409);
  });
});

test("neither ID tokens nor sub values reach the logs", async () => {
  const e = await boot({ publicPerMin: 2 });
  const ok = await e.login("sub-secret-12345");
  await e.login("sub-secret-12345", { aud: "nope" });
  const bad = await e.call("POST", "/v1/auth/google", undefined, { idToken: "tok-secret-xyz" });
  void bad;
  for (let i = 0; i < 3; i++) await e.call("POST", "/v1/auth/google", undefined, { idToken: ok.idToken });
  const all = e.logs.join("\n");
  expect(all).not.toContain("sub-secret-12345");
  expect(all).not.toContain(ok.idToken);
  expect(all).not.toContain("tok-secret-xyz");
  expect(all).not.toContain(ok.body.phoneToken);
});

test("old DBs without the Google tables still open and gain them", async () => {
  const { Database } = await import("bun:sqlite");
  const { ApiStore } = await import("../src/api-store");
  const db = new Database(":memory:");
  db.run("CREATE TABLE phone_accounts (account_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)");
  const store = new ApiStore(db, new FakeClock());
  expect(store.googleLogin("s", "민수").isNew).toBe(true);
  new ApiStore(db, new FakeClock());
});
