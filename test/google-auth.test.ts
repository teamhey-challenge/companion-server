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

async function boot(opts: { configured?: boolean; publicPerMin?: number; allowPhoneOnly?: boolean } = {}) {
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
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability((l) => logs.push(String(l))), dbPath, clock, publicPerMin: opts.publicPerMin ?? 100, allowPhoneOnly: opts.allowPhoneOnly ?? false,
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
  test("valid token returns an unlinked phone token named by given_name; logging in again returns the same one; only claim/account/consents/unpair are open (D-58)", async () => {
    const e = await boot();
    const a = await e.login("sub-aaa");
    expect(a.res.status).toBe(200);
    expect(a.body).toMatchObject({ displayName: "지은", linkedCar: false, isNew: true });
    const t = a.body.phoneToken;
    const acc = await e.call("GET", "/v1/account", t);
    expect(acc.status).toBe(200);
    expect(await acc.json()).toMatchObject({ linkedCar: false });
    expect((await e.call("GET", "/v1/consents", t)).status).toBe(200);
    expect((await e.call("POST", "/v1/consents", t, { type: "record", version: "1", granted: true, channel: "phone" })).status).toBe(200);
    const blocked: [string, string, unknown?][] = [
      ["POST", "/v1/phone-sessions"], ["GET", "/v1/settings"], ["PATCH", "/v1/settings", { speech: "warm" }], ["GET", "/v1/memory"], ["DELETE", "/v1/memory"],
      ["GET", "/v1/friends"], ["POST", "/v1/friends/invites"], ["POST", "/v1/friends/invites/ABCDEFGH/accept"], ["GET", "/v1/messages"], ["POST", "/v1/messages", { toFriendId: "x", text: "hi" }], ["GET", "/v1/diary"],
    ];
    for (const [m, p, body] of blocked) {
      const r = await e.call(m, p, t, body);
      expect([m, p, r.status]).toEqual([m, p, 403]);
      expect(((await r.json()) as { code: string }).code).toBe("car_link_required");
    }
    const b = await e.login("sub-aaa");
    expect(b.body).toMatchObject({ accountId: a.body.accountId, isNew: false, linkedCar: false });
    expect(e.served.fetches).toBe(1);
  });

  test("linked phone works as before; unpair returns to car_link_required", async () => {
    const e = await boot();
    const g = await e.login("sub-lnk");
    expect((await e.claim(await e.car("install-lnk01"), g.body.phoneToken)).res.status).toBe(200);
    const l = await e.login("sub-lnk");
    for (const p of ["/v1/settings", "/v1/memory", "/v1/friends", "/v1/messages", "/v1/diary"]) expect([p, (await e.call("GET", p, l.body.phoneToken)).status]).toEqual([p, 200]);
    expect((await e.call("POST", "/v1/phone-sessions", l.body.phoneToken)).status).toBe(200);
    expect((await e.call("DELETE", "/v1/pairings/current", l.body.phoneToken)).status).toBe(204);
    const after = await e.login("sub-lnk");
    expect((await e.call("GET", "/v1/friends", after.body.phoneToken)).status).toBe(403);
  });

  test("DELETE /v1/phone-sessions/current ends only that token; signing in again restores the car account (linkedCar true) and an unlinked account stays unlinked", async () => {
    const e = await boot();
    const g = await e.login("sub-out");
    expect((await e.claim(await e.car("install-out01"), g.body.phoneToken)).res.status).toBe(200);
    const l = await e.login("sub-out");
    const t = l.body.phoneToken;
    await e.call("PATCH", "/v1/settings", t, { nickname: "하늘" });
    const before = await (await e.call("GET", "/v1/settings", t)).json();
    expect((await e.call("DELETE", "/v1/phone-sessions/current", t)).status).toBe(204);
    expect((await e.call("GET", "/v1/settings", t)).status).toBe(401);
    expect((await e.call("DELETE", "/v1/phone-sessions/current", t)).status).toBe(401);
    const again = await e.login("sub-out");
    expect(again.body).toMatchObject({ accountId: l.body.accountId, linkedCar: true, isNew: false });
    expect(again.body.phoneToken).not.toBe(t);
    expect(await (await e.call("GET", "/v1/settings", again.body.phoneToken)).json()).toEqual(before);
    expect(await (await e.call("GET", "/v1/account", again.body.phoneToken)).json()).toMatchObject({ linkedCar: true });

    const u = await e.login("sub-unl");
    expect((await e.call("DELETE", "/v1/phone-sessions/current", u.body.phoneToken)).status).toBe(204);
    expect((await e.call("GET", "/v1/account", u.body.phoneToken)).status).toBe(401);
    const u2 = await e.login("sub-unl");
    expect(u2.body).toMatchObject({ accountId: u.body.accountId, linkedCar: false, isNew: false });
    expect((await e.call("GET", "/v1/account", u2.body.phoneToken)).status).toBe(200);
  });

  test("friend invite between two car accounts works", async () => {
    const e = await boot();
    const a = await e.login("sub-fa");
    const b = await e.login("sub-fb");
    await e.claim(await e.car("install-fa001"), a.body.phoneToken);
    await e.claim(await e.car("install-fb001"), b.body.phoneToken);
    const ta = (await e.login("sub-fa")).body.phoneToken;
    const tb = (await e.login("sub-fb")).body.phoneToken;
    const inv = (await (await e.call("POST", "/v1/friends/invites", ta)).json()) as { code: string };
    expect((await e.call("POST", `/v1/friends/invites/${inv.code}/accept`, tb)).status).toBe(200);
    expect(((await (await e.call("GET", "/v1/friends", tb)).json()) as { friends?: unknown[] }).friends?.length ?? 1).toBeGreaterThan(0);
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
    expect((await e.call("POST", "/v1/phones/register", undefined, { displayName: "a" })).status).toBe(403);
    const f = await boot({ configured: false, allowPhoneOnly: true });
    expect((await f.call("POST", "/v1/phones/register", undefined, { displayName: "a" })).status).toBe(200);
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

  test("the same Google account re-claiming its own car is fine; a non-Google claim is refused with google_login_required (D-57)", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const a = await e.login("sub-aaa");
    expect((await e.claim(carToken, a.body.phoneToken)).res.status).toBe(200);
    expect((await e.claim(carToken, a.body.phoneToken)).res.status).toBe(200);
    const noToken = await e.claim(carToken);
    expect(noToken.res.status).toBe(403);
    expect(noToken.body.code).toBe("google_login_required");
    const phoneOnly = (await (await (await boot({ allowPhoneOnly: true })).call("POST", "/v1/phones/register", undefined, { displayName: "민수" })).json()) as { phoneToken: string };
    const nonGoogle = await e.claim(carToken, phoneOnly.phoneToken);
    expect(nonGoogle.res.status).toBe(403);
    expect(nonGoogle.body.code).toBe("google_login_required");
    expect((await e.login("sub-aaa")).body.linkedCar).toBe(true);
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

interface PairErr { error?: string; code?: string; phoneToken?: string }
/** Test helper: the tests know the response shape of the server they just started. */
const readJson = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe("D-57 §4.6 pairing rules and failure codes", () => {
  type Env = Awaited<ReturnType<typeof boot>>;
  const newCode = async (e: Env, carToken: string) => readJson<{ pairCode: string; expiresAt: string }>(await e.call("POST", "/v1/pairings", carToken));
  const claimCode = async (e: Env, code: string, token?: string, body: unknown = { record: true, memory: true }) => {
    const res = await e.call("POST", `/v1/pairings/${code}/claim`, token, body);
    return { res, body: await readJson<PairErr>(res.clone()) };
  };

  test("code is 8 chars valid for 300 s; a new car code expires the previous one at once", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const g = await e.login("sub-aaa");
    const first = await newCode(e, carToken);
    expect(first.pairCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(Date.parse(first.expiresAt) - e.clock.t).toBe(300_000);
    const second = await newCode(e, carToken);
    const old = await claimCode(e, first.pairCode, g.body.phoneToken);
    expect([old.res.status, old.body.code]).toEqual([410, "expired"]);
    expect(await readJson<{ status: string }>(await e.call("GET", `/v1/pairings/${first.pairCode}`))).toMatchObject({ status: "expired" });
    expect((await claimCode(e, second.pairCode, g.body.phoneToken)).res.status).toBe(200);
  });

  test("every failure row has its own code: unknown, expired (5 min), already_used, record_consent_required, google_login_required", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const g = await e.login("sub-aaa");
    const unknown = await claimCode(e, "ZZZZZZZZ", g.body.phoneToken);
    expect([unknown.res.status, unknown.body.code]).toEqual([404, "unknown"]);
    const c1 = await newCode(e, carToken);
    const noRecord = await claimCode(e, c1.pairCode, g.body.phoneToken, { record: false, memory: true });
    expect([noRecord.res.status, noRecord.body.code]).toEqual([400, "record_consent_required"]);
    const noGoogle = await claimCode(e, c1.pairCode, undefined);
    expect([noGoogle.res.status, noGoogle.body.code]).toEqual([403, "google_login_required"]);
    e.clock.t += 301_000;
    const expired = await claimCode(e, c1.pairCode, g.body.phoneToken);
    expect([expired.res.status, expired.body.code]).toEqual([410, "expired"]);
    const c2 = await newCode(e, carToken);
    expect((await claimCode(e, c2.pairCode, g.body.phoneToken)).res.status).toBe(200);
    const used = await claimCode(e, c2.pairCode, g.body.phoneToken);
    expect([used.res.status, used.body.code]).toEqual([409, "already_used"]);
  });

  test("google_linked_to_other_car, car_linked_to_other_account and google_verify_failed codes", async () => {
    const e = await boot();
    const a = await e.login("sub-aaa");
    const carA = await e.car("install-aaaa1");
    const carB = await e.car("install-bbbb1");
    expect((await claimCode(e, (await newCode(e, carA)).pairCode, a.body.phoneToken)).res.status).toBe(200);
    const other = await claimCode(e, (await newCode(e, carB)).pairCode, (await e.login("sub-aaa")).body.phoneToken);
    expect([other.res.status, other.body.code]).toEqual([409, "google_linked_to_other_car"]);
    const b = await e.login("sub-bbb");
    const taken = await claimCode(e, (await newCode(e, carA)).pairCode, b.body.phoneToken);
    expect([taken.res.status, taken.body.code]).toEqual([409, "car_linked_to_other_account"]);
    const bad = await e.login("sub-ccc", { aud: "nope" });
    expect([bad.res.status, bad.body.code]).toEqual([401, "google_verify_failed"]);
  });

  test("one car = one phone: a new Google login elsewhere signs the old phone out with 401 signed_in_elsewhere", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const g = await e.login("sub-aaa");
    const c = await claimCode(e, (await newCode(e, carToken)).pairCode, g.body.phoneToken);
    const phone1 = c.body.phoneToken!;
    expect((await e.call("GET", "/v1/settings", phone1)).status).toBe(200);
    const phone2 = (await e.login("sub-aaa")).body.phoneToken;
    const gone = await e.call("GET", "/v1/settings", phone1);
    expect(gone.status).toBe(401);
    expect(await gone.json()).toEqual({ error: "signed_in_elsewhere", code: "signed_in_elsewhere" });
    expect((await e.call("GET", "/v1/settings", phone2)).status).toBe(200);
    // phone-only accounts too
    const p1 = (await e.login("sub-solo")).body.phoneToken;
    await e.login("sub-solo");
    expect((await readJson<PairErr>(await e.call("GET", "/v1/account", p1))).code).toBe("signed_in_elsewhere");
    // a garbage token stays a plain 401
    expect(await (await e.call("GET", "/v1/settings", "nope")).json()).toEqual({ error: "unauthorized" });
  });

  test("unpair from the car revokes the phone token and keeps the car; /v1/account and pairings/current carry the Google name", async () => {
    const e = await boot();
    const carToken = await e.car("install-aaaa1");
    const g = await e.login("sub-aaa", { given_name: "지은" });
    const phoneTok = (await claimCode(e, (await newCode(e, carToken)).pairCode, g.body.phoneToken)).body.phoneToken!;
    expect(await readJson<object>(await e.call("GET", "/v1/pairings/current", carToken))).toMatchObject({ status: "claimed", googleName: "지은" });
    expect(await readJson<object>(await e.call("GET", "/v1/account", phoneTok))).toMatchObject({ accountKind: "car", linkedCar: true, googleName: "지은", phoneOnly: null });
    const solo = await e.login("sub-solo", { given_name: "민수" });
    expect(await readJson<object>(await e.call("GET", "/v1/account", solo.body.phoneToken))).toMatchObject({ accountKind: "phone", linkedCar: false, googleName: "민수", phoneOnly: { friends: 0, messages: 0, hasData: false } });
    expect((await e.call("DELETE", "/v1/pairings/current", carToken)).status).toBe(204);
    expect((await e.call("GET", "/v1/settings", phoneTok)).status).toBe(401);
    expect((await e.call("GET", "/v1/settings", carToken)).status).toBe(200);
    expect((await readJson<{ status: string }>(await e.call("GET", "/v1/pairings/current", carToken))).status).not.toBe("claimed");
    // the Google account is free again (phone-only account)
    expect((await e.login("sub-aaa")).body.linkedCar).toBe(false);
  });
});
