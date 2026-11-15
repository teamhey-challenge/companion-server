import { afterEach, describe, expect, test } from "bun:test";
import type { Clock, TimerHandle } from "../src/clock";
import { Observability } from "../src/observe";
import { createServer, type RunningServer } from "../src/server";
import { FakeTts } from "../src/tts";
import { parseSendIntent, matchFriends } from "../src/voice-intents";
import { friendSaid, ga } from "../src/lines";

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 50 };
const DIARY = "오늘은 회사에 같이 다녀왔어. 중간에 쉬면서 이야기도 했어. 같이 달려서 즐거웠어.";
let diaryFail = false;

let servers: RunningServer[] = [];
afterEach(() => {
  for (const s of servers) void s.stop(true);
  servers = [];
});

const sse = (text: string) => `${[...text].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`).join("")}data: [DONE]\n\n`;

interface Env {
  s: RunningServer;
  base: string;
  call: (method: string, path: string, token?: string, body?: unknown) => Promise<Response>;
  j: <T>(r: Response) => Promise<T>;
}

let diaryGate: Promise<void> | null = null;

function boot(publicPerMin = 5, clock?: Clock): Env {
  const s = createServer({
    allowNonGoogleClaim: true, allowPhoneOnly: true, port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:",
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 100, turnsPerDay: 1000, upgradesPerMin: 100, httpPerMin: 1000 },
    publicPerMin, tripHoldMs: 60, passengerWebUrl: "https://web.test/", tts: new FakeTts(), ...(clock ? { clock } : {}),
    fetchImpl: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      const isDiary = body.messages[0]!.content.includes("일기");
      if (isDiary && diaryFail) return new Response("boom", { status: 500 });
      const text = isDiary ? (await diaryGate, DIARY) : "그렇구나, 좋아!";
      return new Response(sse(text), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch,
  });
  servers.push(s);
  const base = `http://127.0.0.1:${s.port}`;
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;
  return { s, base, call, j };
}


/** 한 쪽 소켓이 받은 JSON 프레임과 바이너리 조각 수. */
class Sock {
  frames: Record<string, unknown>[] = [];
  bins = 0;
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.frames.push(JSON.parse(e.data) as Record<string, unknown>);
      else this.bins++;
    };
  }
  static async open(url: string): Promise<Sock> {
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
    return new Sock(await promise);
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  of(type: string) { return this.frames.filter((f) => f.type === type); }
  async until(pred: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await Bun.sleep(10);
    }
  }
}

async function car(e: Env, installId: string, displayName: string) {
  const reg = await e.j<{ carToken: string }>(await fetch(`${e.base}/v1/cars/register`, { method: "POST", headers: { "x-provision-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify({ installId }) }));
  const token = reg.carToken;
  for (const type of ["record", "external_ai"]) await e.call("POST", "/v1/consents", token, { type, version: "1", granted: true, channel: "car" });
  await e.call("PATCH", "/v1/settings", token, { displayName });
  return token;
}
async function carSocket(e: Env, token: string) {
  const { wsTicket } = await e.j<{ wsTicket: string }>(await e.call("POST", "/v1/sessions", token));
  const sock = await Sock.open(`ws://127.0.0.1:${e.s.port}/v1/talk?ticket=${wsTicket}`);
  sock.send({ type: "hello", v: 1, appVersion: "t" });
  return sock;
}
async function phone(e: Env, displayName: string) {
  const r = await e.j<{ phoneToken: string; accountId: string }>(await e.call("POST", "/v1/phones/register", undefined, { displayName }));
  for (const type of ["record", "external_ai"]) await e.call("POST", "/v1/consents", r.phoneToken, { type, version: "1", granted: true, channel: "phone" });
  return r;
}
async function inbox(e: Env, phoneToken: string) {
  const { wsTicket } = await e.j<{ wsTicket: string }>(await e.call("POST", "/v1/phone-sessions", phoneToken));
  return Sock.open(`ws://127.0.0.1:${e.s.port}/v1/inbox/stream?ticket=${wsTicket}`);
}
async function befriend(e: Env, inviterToken: string, accepterToken: string) {
  const inv = await e.j<{ code: string; url: string; expiresAt: string }>(await e.call("POST", "/v1/friends/invites", inviterToken));
  const acc = await e.j<{ friend: { id: string; name: string } }>(await e.call("POST", `/v1/friends/invites/${inv.code}/accept`, accepterToken));
  return { inv, friend: acc.friend };
}
const friendsOf = async (e: Env, token: string) => e.j<{ id: string; name: string; since: string; shareArrival: boolean }[]>(await e.call("GET", "/v1/friends", token));

describe("accounts", () => {
  test("phone-only registration returns token + accountId, validates the name, and is IP rate limited", async () => {
    const e = boot();
    const r = await e.j<{ phoneToken: string; accountId: string }>(await e.call("POST", "/v1/phones/register", undefined, { displayName: "민수" }));
    expect(r.phoneToken.length).toBeGreaterThan(20);
    expect(r.accountId).toMatch(/^ph_/);
    const me = await e.j<{ displayName: string }>(await e.call("GET", "/v1/settings", r.phoneToken));
    expect(me.displayName).toBe("민수");
    expect((await e.call("POST", "/v1/phones/register", undefined, { displayName: "" })).status).toBe(400);
    expect((await e.call("POST", "/v1/phones/register", undefined, { displayName: "가".repeat(21) })).status).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await e.call("POST", "/v1/phones/register", undefined, { displayName: "x" })).status);
    expect(codes).toContain(429);
  });

  test("phone token may patch displayName but not proactive; checkinTime no longer exists (D-52)", async () => {
    const e = boot();
    const p = await phone(e, "지은");
    expect((await e.call("PATCH", "/v1/settings", p.phoneToken, { checkinTime: "08:30" })).status).toBe(400);
    expect(await e.j(await e.call("GET", "/v1/settings", p.phoneToken))).not.toHaveProperty("checkinTime");
    expect((await e.call("PATCH", "/v1/settings", p.phoneToken, { displayName: "하늘" })).status).toBe(200);
    expect((await e.call("PATCH", "/v1/settings", p.phoneToken, { proactive: "off" })).status).toBe(403);
  });

  test("phone-sessions: only phone tokens, the inbox ticket works once and is not a car ticket", async () => {
    const e = boot();
    const c = await car(e, "install-aaaa1", "지은");
    expect((await e.call("POST", "/v1/phone-sessions", c)).status).toBe(403);
    const p = await phone(e, "민수");
    const { wsTicket } = await e.j<{ wsTicket: string }>(await e.call("POST", "/v1/phone-sessions", p.phoneToken));
    await Sock.open(`ws://127.0.0.1:${e.s.port}/v1/inbox/stream?ticket=${wsTicket}`);
    await expect(Sock.open(`ws://127.0.0.1:${e.s.port}/v1/inbox/stream?ticket=${wsTicket}`)).rejects.toThrow();
    const carTicket = (await e.j<{ wsTicket: string }>(await e.call("POST", "/v1/sessions", c))).wsTicket;
    await expect(Sock.open(`ws://127.0.0.1:${e.s.port}/v1/inbox/stream?ticket=${carTicket}`)).rejects.toThrow();
  });
});

describe("friends", () => {
  test("invite → accept makes a mutual friendship; url uses PASSENGER_WEB_URL; self and unknown codes fail", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { inv, friend } = await befriend(e, a, b.phoneToken);
    expect(inv.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(inv.url).toBe(`https://web.test/f/${inv.code}`);
    expect(Date.parse(inv.expiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(friend.name).toBe("지은");
    expect((await friendsOf(e, a)).map((f) => f.name)).toEqual(["민수"]);
    expect((await friendsOf(e, b.phoneToken)).map((f) => f.name)).toEqual(["지은"]);
    expect((await friendsOf(e, a))[0]!.shareArrival).toBe(false);
    expect((await e.call("POST", `/v1/friends/invites/${inv.code}/accept`, a)).status).toBe(400);
    expect((await e.call("POST", "/v1/friends/invites/ZZZZZZ/accept", b.phoneToken)).status).toBe(404);
  });

  test("unfriend removes both sides and hides the old messages", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    expect((await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "안녕" })).status).toBe(201);
    const mine = (await friendsOf(e, a))[0]!;
    expect((await e.call("DELETE", `/v1/friends/${mine.id}`, a)).status).toBe(204);
    expect(await friendsOf(e, a)).toEqual([]);
    expect(await friendsOf(e, b.phoneToken)).toEqual([]);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", a))).messages).toEqual([]);
  });
});

describe("messages", () => {
  test("blocked by the safety filter → 422 message_blocked, nothing stored; too long → 400", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    for (const text of ["씨발 뭐해", "여기 봐 https://evil.example/x", "죽고 싶어"]) {
      const r = await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text });
      expect(r.status).toBe(422);
      expect(await r.json()).toMatchObject({ code: "message_blocked", error: "message_blocked" });
    }
    expect((await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "가".repeat(121) })).status).toBe(400);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", a))).messages).toEqual([]);
  });

  test("send/list: newest first with direction and friendName; since filters", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "오늘 늦어" });
    const aFriend = (await friendsOf(e, a))[0]!;
    await e.call("POST", "/v1/messages", a, { toFriendId: aFriend.id, text: "알았어" });
    const inA = (await e.j<{ messages: { direction: string; friendName: string; text: string; at: string }[] }>(await e.call("GET", "/v1/messages", a))).messages;
    expect(inA.map((m) => [m.direction, m.friendName, m.text])).toEqual([["out", "민수", "알았어"], ["in", "민수", "오늘 늦어"]]);
    const later = (await e.j<{ messages: unknown[] }>(await e.call("GET", `/v1/messages?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, a))).messages;
    expect(later).toEqual([]);
  });

  test("report: only the recipient; the message disappears from the recipient inbox and a count is stored", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    const sent = await e.j<{ id: string }>(await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "안녕 지은" }));
    expect((await e.call("POST", `/v1/messages/${sent.id}/report`, b.phoneToken)).status).toBe(404);
    expect((await e.call("POST", `/v1/messages/${sent.id}/report`, a)).status).toBe(204);
    const inA = (await e.j<{ messages: { id: string; direction: string }[] }>(await e.call("GET", "/v1/messages", a))).messages;
    expect(inA.find((m) => m.id === sent.id)).toBeUndefined();
  });

  test("a phone token cannot read, report or send as another account's conversation", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const stranger = await phone(e, "낯선이");
    const { friend } = await befriend(e, a, b.phoneToken);
    const sent = await e.j<{ id: string }>(await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "비밀 얘기" }));
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", stranger.phoneToken))).messages).toEqual([]);
    expect((await e.call("POST", `/v1/messages/${sent.id}/report`, stranger.phoneToken)).status).toBe(404);
    expect((await e.call("POST", "/v1/messages", stranger.phoneToken, { toFriendId: friend.id, text: "끼어들기" })).status).toBe(404);
    expect(await friendsOf(e, stranger.phoneToken)).toEqual([]);
    expect((await e.call("GET", "/v1/messages")).status).toBe(401);
  });
});

describe("push", () => {
  test("friend_message reaches the car talk socket with the spoken PCM line and the phone inbox stream", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    const carSock = await carSocket(e, a);
    const aInbox = await inbox(e, (await e.j<{ phoneToken: string }>(await (async () => {
      const pc = (await e.j<{ pairCode: string }>(await e.call("POST", "/v1/pairings", a))).pairCode;
      return e.call("POST", `/v1/pairings/${pc}/claim`, undefined, { record: true, memory: true });
    })())).phoneToken);
    const sent = await e.j<{ id: string }>(await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "오늘 저녁 같이 먹자" }));
    await carSock.until(() => carSock.of("reply.end").length === 1);
    expect(carSock.of("friend_message")[0]).toEqual({ type: "friend_message", id: sent.id, fromName: "민수", text: "오늘 저녁 같이 먹자" });
    expect(carSock.of("reply.start")[0]).toMatchObject({ turnId: sent.id, audio: { format: "pcm_s16le", sampleRate: 24000, channels: 1 } });
    expect(carSock.of("reply.end")[0]).toMatchObject({ turnId: sent.id, text: "민수가 그러는데, 오늘 저녁 같이 먹자" });
    expect(carSock.bins).toBeGreaterThan(0);
    await aInbox.until(() => aInbox.of("friend_message").length === 1);
    expect(aInbox.of("friend_message")[0]).toMatchObject({ id: sent.id, fromName: "민수" });
  });

  test("a message sent while the car is offline is read out when the car connects", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "먼저 갈게" });
    const carSock = await carSocket(e, a);
    await carSock.until(() => carSock.of("reply.end").length === 1);
    expect(carSock.of("friend_message")[0]).toMatchObject({ fromName: "민수", text: "먼저 갈게" });
  });

  test("friend_arrived: only when the sender enabled shareArrival; carries no place, and the spoken line has no destination (D-53)", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    await befriend(e, a, b.phoneToken);
    const bInbox = await inbox(e, b.phoneToken);
    const carSock = await carSocket(e, a);
    const drive = async (place: string) => {
      carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
      carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40, destinationName: place } });
      carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, arrived: true } });
    };
    await drive("회사");
    await Bun.sleep(150);
    expect(bInbox.of("friend_arrived")).toEqual([]);
    const mine = (await friendsOf(e, a))[0]!;
    expect((await e.call("PATCH", `/v1/friends/${mine.id}`, a, { shareArrival: true })).status).toBe(200);
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40, arrived: false, destinationName: "카페 하늘" } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, arrived: true } });
    await bInbox.until(() => bInbox.of("friend_arrived").length === 1);
    expect(bInbox.of("friend_arrived")[0]).toEqual({ type: "friend_arrived", id: expect.any(String), fromName: "지은" });
    await Bun.sleep(100);
    expect(JSON.stringify(bInbox.frames)).not.toContain("카페 하늘");
  });

  test("friend_arrived is sent on arrival even when no destination was ever sent (D-53: place is never sent)", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    await befriend(e, a, b.phoneToken);
    const mine = (await friendsOf(e, a))[0]!;
    await e.call("PATCH", `/v1/friends/${mine.id}`, a, { shareArrival: true });
    const bInbox = await inbox(e, b.phoneToken);
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40 } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, arrived: true } });
    await bInbox.until(() => bInbox.of("friend_arrived").length === 1);
    expect(bInbox.of("friend_arrived")[0]).toEqual({ type: "friend_arrived", id: expect.any(String), fromName: "지은" });
  });

  test("friend cap: the 51st accepted invite is refused with 409", async () => {
    const e = boot(500);
    const a = await car(e, "install-aaaa1", "지은");
    for (let i = 0; i < 50; i++) {
      const p = await phone(e, `친구${i}`);
      expect((await e.call("POST", `/v1/friends/invites/${(await e.j<{ code: string }>(await e.call("POST", "/v1/friends/invites", a))).code}/accept`, p.phoneToken)).status).toBe(200);
    }
    const last = await phone(e, "마지막");
    const inv = await e.j<{ code: string }>(await e.call("POST", "/v1/friends/invites", a));
    expect((await e.call("POST", `/v1/friends/invites/${inv.code}/accept`, last.phoneToken)).status).toBe(409);
    expect((await friendsOf(e, a)).length).toBe(50);
  });

  test("friend_arrived to a car is spoken as '<name>가 도착했대' without the destination", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await car(e, "install-bbbb2", "민수");
    await befriend(e, a, b);
    const mine = (await friendsOf(e, a))[0]!;
    await e.call("PATCH", `/v1/friends/${mine.id}`, a, { shareArrival: true });
    const bSock = await carSocket(e, b);
    const aSock = await carSocket(e, a);
    aSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    aSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40, destinationName: "카페 하늘" } });
    aSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, arrived: true } });
    await bSock.until(() => bSock.of("reply.end").length === 1);
    expect(bSock.of("friend_arrived")[0]).toEqual({ type: "friend_arrived", id: expect.any(String), fromName: "지은", });
    expect(bSock.of("reply.end")[0]!.text).toBe("지은이가 도착했대!");
  });

  test("coordinates are never used as a place name", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    await befriend(e, a, b.phoneToken);
    const mine = (await friendsOf(e, a))[0]!;
    await e.call("PATCH", `/v1/friends/${mine.id}`, a, { shareArrival: true });
    const bInbox = await inbox(e, b.phoneToken);
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40, destinationName: "37.51234, 127.05678" } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, arrived: true } });
    await bInbox.until(() => bInbox.of("friend_arrived").length === 1);
    expect(bInbox.of("friend_arrived")[0]).not.toHaveProperty("place");
  });
});

describe("trip end and diary", () => {
  const paired = async (e: Env, a: string) => {
    const pc = (await e.j<{ pairCode: string }>(await e.call("POST", "/v1/pairings", a))).pairCode;
    return (await e.j<{ phoneToken: string }>(await e.call("POST", `/v1/pairings/${pc}/claim`, undefined, { record: true, memory: true }))).phoneToken;
  };

  test("gear P + driver door open ends the trip at once: trip_done then diary_ready; GET /v1/diary has entries and a summary without coordinates", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const phoneTok = await paired(e, a);
    const stream = await inbox(e, phoneTok);
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40, destinationName: "회사", wiper: "high" } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    await Bun.sleep(30);
    expect(stream.of("trip_done")).toEqual([]);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true } });
    await stream.until(() => stream.of("diary_ready").length === 1);
    const done = stream.of("trip_done")[0]!;
    expect(done.text).toBe("오늘도 같이 달렸어. 회사 도착 축하해!");
    const date = String(done.date);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stream.of("diary_ready")[0]).toEqual({ type: "diary_ready", date });
    const diary = await e.j<{ date: string; entries: { kind: string; text: string }[]; summary: string }>(await e.call("GET", `/v1/diary?date=${date}`, phoneTok));
    expect(diary.entries.map((x) => x.kind)).toEqual(["trip_start", "trip_done"]);
    expect(diary.summary).toBe(DIARY);
    expect([diary.summary, ...diary.entries.map((x) => x.text)].join(" ")).not.toMatch(/\d+\.\d{3,}/);
  });

  test("without the door signal, P held for the hold time ends the trip; a single trip ends only once", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const stream = await inbox(e, await paired(e, a));
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    await stream.until(() => stream.of("trip_done").length === 1);
    expect(stream.of("trip_done")[0]!.text).toBe("오늘도 같이 달렸어. 수고했어!");
    expect(stream.of("trip_done")[0]).toMatchObject({ id: expect.any(String), at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    await carSock.until(() => carSock.of("trip_done").length === 1);
    expect(carSock.of("trip_done")[0]).toEqual(stream.of("trip_done")[0]!);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true } });
    await Bun.sleep(150);
    expect(stream.of("trip_done")).toHaveLength(1);
  });

  test("a passenger door opening in P does not end the trip when the driver door signal is present; the driver door does", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const stream = await inbox(e, await paired(e, a));
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: false, doorOpen: false } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: false, doorOpen: true } });
    await Bun.sleep(30);
    expect(stream.of("trip_done")).toEqual([]);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true, doorOpen: true } });
    await stream.until(() => stream.of("trip_done").length === 1);
  });

  test("going back to D before the hold time cancels the end; diary of another account is empty", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const other = await phone(e, "낯선이");
    const stream = await inbox(e, await paired(e, a));
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    await Bun.sleep(150);
    expect(stream.of("trip_done")).toEqual([]);
    const theirs = await e.j<{ entries: unknown[]; summary: string | null }>(await e.call("GET", "/v1/diary", other.phoneToken));
    expect(theirs.entries).toEqual([]);
    expect(theirs.summary).toBeNull();
  });
});

describe("D-53 consent withdrawal and memory-off", () => {
  const paired = async (e: Env, a: string) => {
    const pc = (await e.j<{ pairCode: string }>(await e.call("POST", "/v1/pairings", a))).pairCode;
    return (await e.j<{ phoneToken: string }>(await e.call("POST", `/v1/pairings/${pc}/claim`, undefined, { record: true, memory: true }))).phoneToken;
  };
  const memConsent = (e: Env, token: string, channel: "car" | "phone") => e.call("POST", "/v1/consents", token, { type: "memory", version: "1", granted: true, channel });
  const drive = async (e: Env, a: string) => {
    const s = await carSocket(e, a);
    s.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    s.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    s.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    return s;
  };

  test("withdrawing memory consent deletes diary and friend messages (sent + received) at once; others' copies stay", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    await memConsent(e, a, "car");
    const b = await phone(e, "민수");
    await memConsent(e, b.phoneToken, "phone");
    const { friend } = await befriend(e, a, b.phoneToken);
    const mine = (await friendsOf(e, a))[0]!;
    await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "받는 글" });
    await e.call("POST", "/v1/messages", a, { toFriendId: mine.id, text: "보내는 글" });
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const before = await e.j<{ entries: unknown[] }>(await e.call("GET", `/v1/diary?date=${today}`, a));
    expect(before.entries.length).toBe(2);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", a))).messages.length).toBe(2);
    expect((await e.call("DELETE", "/v1/consents/memory", a)).status).toBe(204);
    const after = await e.j<{ entries: unknown[]; summary: unknown }>(await e.call("GET", `/v1/diary?date=${today}`, a));
    expect(after.entries).toEqual([]);
    expect(after.summary).toBeNull();
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", a))).messages).toEqual([]);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", b.phoneToken))).messages).toEqual([]);
    expect((await e.j<{ entries: unknown[] }>(await e.call("GET", `/v1/diary?date=${today}`, b.phoneToken))).entries.length).toBe(2);
  });

  test("POST consent granted:false (record) also purges diary and messages", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    await memConsent(e, a, "car");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "안녕" });
    expect((await e.call("POST", "/v1/consents", a, { type: "record", version: "1", granted: false, channel: "car" })).status).toBe(200);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", a))).messages).toEqual([]);
  });

  test("memory saving OFF: no diary entries or summary, but trip_done is still sent", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const phoneTok = await paired(e, a);
    expect((await e.call("PATCH", "/v1/settings", a, { memoryEnabled: false })).status).toBe(200);
    const stream = await inbox(e, phoneTok);
    const carSock = await drive(e, a);
    await stream.until(() => stream.of("trip_done").length === 1);
    await Bun.sleep(100);
    expect(stream.of("diary_ready")).toEqual([]);
    const today = String(stream.of("trip_done")[0]!.date);
    const d = await e.j<{ entries: unknown[]; summary: unknown }>(await e.call("GET", `/v1/diary?date=${today}`, phoneTok));
    expect(d.entries).toEqual([]);
    expect(d.summary).toBeNull();
    carSock.ws.close();
  });
});

describe("voice intents in car talk", () => {
  const say = async (sock: Sock, id: string, text: string) => {
    sock.send({ type: "turn.start", turnId: id, trigger: "ptt" });
    sock.send({ type: "ctx", turnId: id, ctx: { gear: "P", speedKmh: 0 } });
    sock.send({ type: "text", turnId: id, text });
    sock.send({ type: "turn.end", turnId: id });
    await sock.until(() => sock.frames.some((f) => f.turnId === id && f.type === "reply.end"));
    return String(sock.frames.find((f) => f.turnId === id && f.type === "reply.end")!.text);
  };

  test("parser: named, reply and non-matching phrases", () => {
    expect(parseSendIntent("민수한테 오늘 늦는다고 전해 줘")).toEqual({ name: "민수", text: "오늘 늦는다" });
    expect(parseSendIntent("고맙다고 전해 줘")).toEqual({ name: null, text: "고마워!" });
    expect(parseSendIntent("지은이에게 곧 도착한다고 전해줘")).toEqual({ name: "지은이", text: "곧 도착한다" });
    expect(parseSendIntent("오늘 날씨 어때")).toBeNull();
    expect(parseSendIntent("전해 줘")).toBeNull();
    expect(parseSendIntent("나한테 재밌는 얘기 말해 줘")).toBeNull();
    expect(parseSendIntent("내일 비 온다고 알려 줘")).toBeNull();
    expect(parseSendIntent("나한테 곧 간다고 전해 줘")).toBeNull();
    expect(parseSendIntent("민수한테오늘늦는다고전해줘")).toEqual({ name: "민수", text: "오늘늦는다" });
    expect(parseSendIntent("민수한테 곧 간다고 전해 달라고")).toEqual({ name: "민수", text: "곧 간다" });
    expect(matchFriends("민", [{ name: "민수" }])).toEqual([]);
    expect(matchFriends("민수야", [{ name: "민수" }, { name: "지은" }])).toEqual([{ name: "민수" }]);
    expect(ga("민수")).toBe("민수가");
    expect(ga("지은")).toBe("지은이가");
    expect(friendSaid("지은", "안녕", "banmal")).toBe("지은이가 그러는데, 안녕");
  });

  test("H-1: withdrawing memory consent while the diary LLM is running drops the summary and the diary_ready push", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const pc = (await e.j<{ pairCode: string }>(await e.call("POST", "/v1/pairings", a))).pairCode;
    const phoneTok = (await e.j<{ phoneToken: string }>(await e.call("POST", `/v1/pairings/${pc}/claim`, undefined, { record: true, memory: true }))).phoneToken;
    const stream = await inbox(e, phoneTok);
    const { promise, resolve } = Promise.withResolvers<void>();
    diaryGate = promise;
    try {
      const carSock = await carSocket(e, a);
      carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
      carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30, destinationName: "회사" } });
      carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
      await stream.until(() => stream.of("trip_done").length === 1);
      expect((await e.call("DELETE", "/v1/consents/memory", a)).status).toBe(204);
      resolve();
      await Bun.sleep(150);
      expect(stream.of("diary_ready")).toEqual([]);
      const today = String(stream.of("trip_done")[0]!.date);
      const d = await e.j<{ entries: unknown[]; summary: unknown }>(await e.call("GET", `/v1/diary?date=${today}`, phoneTok));
      expect(d.summary).toBeNull();
      carSock.ws.close();
    } finally {
      resolve();
      diaryGate = null;
    }
  });

  test("'민수한테 늦는다고 전해 줘' sends a message and confirms by voice; the phone receives it", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    await befriend(e, a, b.phoneToken);
    const bInbox = await inbox(e, b.phoneToken);
    const carSock = await carSocket(e, a);
    expect(await say(carSock, "v1", "민수한테 오늘 늦는다고 전해 줘")).toBe("민수한테 전했어!");
    await bInbox.until(() => bInbox.of("friend_message").length === 1);
    expect(bInbox.of("friend_message")[0]).toMatchObject({ fromName: "지은", text: "오늘 늦는다" });
  });

  test("ambiguous names ask back, the next answer sends; unknown names are said so", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const m1 = await phone(e, "김민수");
    const m2 = await phone(e, "김민석");
    await befriend(e, a, m1.phoneToken);
    await befriend(e, a, m2.phoneToken);
    const carSock = await carSocket(e, a);
    expect(await say(carSock, "v1", "김민한테 곧 간다고 전해 줘")).toContain("김민수, 김민석");
    expect(await say(carSock, "v2", "김민석")).toBe("김민석한테 전했어!");
    const got = (await e.j<{ messages: { text: string }[] }>(await e.call("GET", "/v1/messages", m2.phoneToken))).messages;
    expect(got.map((m) => m.text)).toEqual(["곧 간다"]);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", m1.phoneToken))).messages).toEqual([]);
    expect(await say(carSock, "v3", "철수한테 안녕이라고 전해 줘")).toBe("그런 친구는 없어. 폰에서 친구를 먼저 추가해 줘");
  });

  test("'고맙다고 전해 줘' right after a friend message replies to that sender", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    const bInbox = await inbox(e, b.phoneToken);
    const carSock = await carSocket(e, a);
    await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "선물 보냈어" });
    await carSock.until(() => carSock.of("reply.end").length === 1);
    expect(await say(carSock, "v1", "고맙다고 전해 줘")).toBe("민수한테 전했어!");
    await bInbox.until(() => bInbox.of("friend_message").length === 1);
    expect(bInbox.of("friend_message")[0]).toMatchObject({ fromName: "지은", text: "고마워!" });
  });

  test("a blocked spoken message is refused by voice and nothing is sent", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    await befriend(e, a, b.phoneToken);
    const carSock = await carSocket(e, a);
    expect(await say(carSock, "v1", "민수한테 씨발 꺼지라고 전해 줘")).toContain("전하기");
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", b.phoneToken))).messages).toEqual([]);
  });

  test("§6.3 server lines: too long (>120) and unfriended and unknown", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    const carSock = await carSocket(e, a);
    expect(await say(carSock, "v1", `민수한테 ${"가".repeat(121)}라고 전해 줘`)).toBe("조금 짧게 말해 줄래?");
    expect(await say(carSock, "v2", "민수한테 씨발 꺼지라고 전해 줘")).toBe("그 말은 전하기 어려워");
    await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: "안녕" });
    expect(await e.call("DELETE", `/v1/friends/${(await friendsOf(e, a))[0]!.id}`, a)).toHaveProperty("status", 204);
    expect(await say(carSock, "v3", "민수한테 잘 지내라고 전해 줘")).toBe("이제 친구가 아니라서 전할 수 없어");
    expect(await say(carSock, "v4", "철수한테 잘 지내라고 전해 줘")).toBe("그런 친구는 없어. 폰에서 친구를 먼저 추가해 줘");
  });

  test("§6.3 queue: while driving at most 3 messages are read in arrival order, then one 'more' line; the rest is read after parking", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const b = await phone(e, "민수");
    const { friend } = await befriend(e, a, b.phoneToken);
    const carSock = await carSocket(e, a);
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 40 } });
    for (const t of ["하나", "둘", "셋", "넷", "다섯"]) await e.call("POST", "/v1/messages", b.phoneToken, { toFriendId: friend.id, text: t });
    await carSock.until(() => carSock.of("friend_more").length === 1 && carSock.of("reply.end").length === 4, 8000);
    expect(carSock.of("friend_message").map((f) => f.text)).toEqual(["하나", "둘", "셋", "넷", "다섯"]);
    expect(carSock.of("reply.end").map((f) => f.text)).toEqual(["민수가 그러는데, 하나", "민수가 그러는데, 둘", "민수가 그러는데, 셋", "친구 말이 더 있어, 멈추면 보여 줄게"]);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    await carSock.until(() => carSock.of("reply.end").length === 6, 8000);
    expect(carSock.of("reply.end").slice(4).map((f) => f.text)).toEqual(["민수가 그러는데, 넷", "민수가 그러는데, 다섯"]);
    expect(carSock.of("friend_more")).toHaveLength(1);
  });
});

/** Real timers, but the wall clock can be moved (midnight tests). */
class SkewClock implements Clock {
  skew = 0;
  now() { return Date.now() + this.skew; }
  setTimeout(fn: () => void, ms: number): TimerHandle { return globalThis.setTimeout(fn, ms) as unknown as TimerHandle; }
  clearTimeout(h: TimerHandle) { globalThis.clearTimeout(h as unknown as ReturnType<typeof globalThis.setTimeout>); }
}

describe("§6.4 trip end diary edge cases", () => {
  const claim = async (e: Env, a: string, memory = true) => {
    const pc = (await e.j<{ pairCode: string }>(await e.call("POST", "/v1/pairings", a))).pairCode;
    return (await e.j<{ phoneToken: string }>(await e.call("POST", `/v1/pairings/${pc}/claim`, undefined, { record: true, memory }))).phoneToken;
  };
  const drive = (s: Sock, extra: Record<string, unknown> = {}) => {
    s.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    s.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30, ...extra } });
    s.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true } });
  };

  test("very short trip: one-line diary and the car says the diary is ready", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const phoneTok = await claim(e, a);
    const stream = await inbox(e, phoneTok);
    const carSock = await carSocket(e, a);
    drive(carSock);
    await stream.until(() => stream.of("diary_ready").length === 1);
    const done = stream.of("trip_done")[0]!;
    expect(done).toMatchObject({ carLine: "오늘 일기 써 뒀어, 폰에서 봐!", phoneLinked: true });
    const d = await e.j<{ summary: string }>(await e.call("GET", `/v1/diary?date=${String(done.date)}`, phoneTok));
    expect(d.summary).toBe("오늘은 짧게 같이 달렸다");
  });

  test("no phone linked: the diary is still written on the server and the car says to connect the phone", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    await e.call("POST", "/v1/consents", a, { type: "memory", version: "1", granted: true, channel: "car" });
    const carSock = await carSocket(e, a);
    drive(carSock, { destinationName: "회사" });
    await carSock.until(() => carSock.of("trip_done").length === 1);
    expect(carSock.of("trip_done")[0]).toMatchObject({ carLine: "폰을 연결하면 일기를 볼 수 있어", phoneLinked: false });
    const date = String(carSock.of("trip_done")[0]!.date);
    await Bun.sleep(150);
    expect((await e.j<{ summary: string }>(await e.call("GET", `/v1/diary?date=${date}`, a))).summary).toBe(DIARY);
  });

  test("memory off: no diary, no diary_ready, the car only says '오늘도 같이 달렸어'", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const phoneTok = await claim(e, a, false);
    const stream = await inbox(e, phoneTok);
    const carSock = await carSocket(e, a);
    drive(carSock, { destinationName: "회사" });
    await stream.until(() => stream.of("trip_done").length === 1);
    expect(stream.of("trip_done")[0]).toMatchObject({ carLine: "오늘도 같이 달렸어" });
    await Bun.sleep(150);
    expect(stream.of("diary_ready")).toEqual([]);
    expect((await e.j<{ summary: unknown; entries: unknown[] }>(await e.call("GET", `/v1/diary`, phoneTok)))).toMatchObject({ summary: null, entries: [] });
  });

  test("diary write failure: no phone diary_ready push; the next trip end writes it again", async () => {
    const e = boot();
    const a = await car(e, "install-aaaa1", "지은");
    const phoneTok = await claim(e, a);
    const stream = await inbox(e, phoneTok);
    const carSock = await carSocket(e, a);
    diaryFail = true;
    try {
      drive(carSock, { destinationName: "회사" });
      await stream.until(() => stream.of("trip_done").length === 1);
      await Bun.sleep(200);
      expect(stream.of("diary_ready")).toEqual([]);
    } finally {
      diaryFail = false;
    }
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: false } });
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true } });
    await stream.until(() => stream.of("diary_ready").length >= 1);
    expect(stream.of("diary_ready")[0]).toEqual({ type: "diary_ready", date: String(stream.of("trip_done")[0]!.date) });
  });

  test("a trip that crosses midnight goes into the diary of the day it started", async () => {
    const clock = new SkewClock();
    const e = boot(5, clock);
    const a = await car(e, "install-aaaa1", "지은");
    const phoneTok = await claim(e, a);
    const stream = await inbox(e, phoneTok);
    const carSock = await carSocket(e, a);
    // start the trip at 23:50 KST, end it after midnight
    const kst = new Date(Date.now() + 9 * 3_600_000);
    kst.setUTCHours(23, 50, 0, 0);
    clock.skew = kst.getTime() - 9 * 3_600_000 - Date.now();
    const startDay = kst.toISOString().slice(0, 10);
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    carSock.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30, destinationName: "회사" } });
    await Bun.sleep(50);
    clock.skew += 20 * 60_000;
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true } });
    await stream.until(() => stream.of("diary_ready").length === 1);
    expect(stream.of("trip_done")[0]).toMatchObject({ date: startDay });
    expect((await e.j<{ summary: string }>(await e.call("GET", `/v1/diary?date=${startDay}`, phoneTok))).summary).toBe(DIARY);
  });
});
