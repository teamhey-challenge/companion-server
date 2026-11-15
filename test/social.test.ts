import { afterEach, describe, expect, test } from "bun:test";
import { Observability } from "../src/observe";
import { createServer, type RunningServer } from "../src/server";
import { FakeTts } from "../src/tts";
import { parseSendIntent, matchFriends } from "../src/voice-intents";
import { friendSaid, ga } from "../src/lines";

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 50 };
const DIARY = "오늘은 회사에 같이 다녀왔어. 중간에 쉬면서 이야기도 했어. 같이 달려서 즐거웠어.";

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

function boot(): Env {
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:",
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 100, turnsPerDay: 1000, upgradesPerMin: 100, httpPerMin: 1000 },
    publicPerMin: 5, tripHoldMs: 60, passengerWebUrl: "https://web.test/", tts: new FakeTts(),
    fetchImpl: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      const text = body.messages[0]!.content.includes("일기") ? DIARY : "그렇구나, 좋아!";
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

  test("phone token may patch displayName and checkinTime but not proactive; values validated", async () => {
    const e = boot();
    const p = await phone(e, "지은");
    expect((await e.call("PATCH", "/v1/settings", p.phoneToken, { checkinTime: "08:30" })).status).toBe(200);
    expect((await e.call("PATCH", "/v1/settings", p.phoneToken, { checkinTime: "25:00" })).status).toBe(400);
    expect((await e.call("PATCH", "/v1/settings", p.phoneToken, { checkinTime: null })).status).toBe(200);
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

  test("friend_arrived: only when the sender enabled shareArrival for that friend, place = destination name only", async () => {
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
    expect(bInbox.of("friend_arrived")[0]).toMatchObject({ type: "friend_arrived", fromName: "지은", place: "카페 하늘" });
    expect(typeof bInbox.of("friend_arrived")[0]!.id).toBe("string");
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
    expect(bInbox.of("friend_arrived")[0]!.place).toBeUndefined();
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
    carSock.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0, driverDoorOpen: true } });
    await Bun.sleep(150);
    expect(stream.of("trip_done")).toHaveLength(1);
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
    expect(parseSendIntent("지은이에게 곧 도착한다고 말해줘")).toEqual({ name: "지은이", text: "곧 도착한다" });
    expect(parseSendIntent("오늘 날씨 어때")).toBeNull();
    expect(parseSendIntent("전해 줘")).toBeNull();
    expect(matchFriends("민수야", [{ name: "민수" }, { name: "지은" }])).toEqual([{ name: "민수" }]);
    expect(ga("민수")).toBe("민수가");
    expect(ga("지은")).toBe("지은이가");
    expect(friendSaid("지은", "안녕", "banmal")).toBe("지은이가 그러는데, 안녕");
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
    const m1 = await phone(e, "민수");
    const m2 = await phone(e, "민석");
    await befriend(e, a, m1.phoneToken);
    await befriend(e, a, m2.phoneToken);
    const carSock = await carSocket(e, a);
    expect(await say(carSock, "v1", "민한테 곧 간다고 전해 줘")).toContain("민수, 민석");
    expect(await say(carSock, "v2", "민석")).toBe("민석한테 전했어!");
    const got = (await e.j<{ messages: { text: string }[] }>(await e.call("GET", "/v1/messages", m2.phoneToken))).messages;
    expect(got.map((m) => m.text)).toEqual(["곧 간다"]);
    expect((await e.j<{ messages: unknown[] }>(await e.call("GET", "/v1/messages", m1.phoneToken))).messages).toEqual([]);
    expect(await say(carSock, "v3", "철수한테 안녕이라고 전해 줘")).toContain("못 찾았어");
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
});
