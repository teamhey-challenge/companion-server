import { afterEach, describe, expect, test } from "bun:test";
import { SystemClock, type Clock } from "../src/clock";
import { Observability } from "../src/observe";
import { createServer, type RunningServer } from "../src/server";
import { FakeTts } from "../src/tts";
import { checkInput, checkOutput } from "../src/safety";
import { parseForget, parseSpeechChange, answerNickname, answerChat } from "../src/intents";
import { SentenceSplitter } from "../src/tts";

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 50 };

let servers: RunningServer[] = [];
afterEach(() => {
  for (const s of servers) void s.stop(true);
  servers = [];
});

interface Frame { type: string; turnId?: string; id?: string; reason?: string; text?: string; settings?: { speech: string }; code?: string }

const sse = (text: string) =>
  `${[...text].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`).join("")}data: [DONE]\n\n`;

interface Llm { replies: string[]; extraction: string; calls: { system: string; user: string }[]; extractCalls: number }

function boot(llm: Llm, tts = false, clock?: Clock, extra: { llmDeadlineMs?: number; stall?: boolean } = {}) {
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:",
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 100, turnsPerDay: 1000, upgradesPerMin: 100, httpPerMin: 1000 },
    arrivalDelayMs: 30,
    clock,
    llmDeadlineMs: extra.llmDeadlineMs,
    tts: tts ? new FakeTts() : null,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      if (extra.stall) {
        // 첫 글자만 보내고 멈추는 공급사: 끊기(abort) 전에는 스트림이 끝나지 않는다.
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "음" } }] })}\n\n`));
            init.signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      const system = body.messages[0]!.content;
      const user = body.messages[1]!.content;
      if (system.includes("[기억 추출]")) {
        llm.extractCalls++;
        return new Response(sse(llm.extraction), { headers: { "content-type": "text/event-stream" } });
      }
      llm.calls.push({ system, user });
      const text = system.includes("먼저 말 걸기: arrival") || system.includes("먼저 말 걸기: greeting") ? "NONE" : (llm.replies.shift() ?? "그렇구나, 좋아!");
      return new Response(sse(text), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch,
  });
  servers.push(s);
  const base = `http://127.0.0.1:${s.port}`;
  return { base, port: s.port };
}

class Car {
  frames: Frame[] = [];
  private constructor(readonly base: string, readonly token: string, private ws: WebSocket) {
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.frames.push(JSON.parse(e.data));
    };
  }
  static async connect(b: { base: string; port: number | undefined }, installId = "install-0001") {
    const reg = await fetch(`${b.base}/v1/cars/register`, { method: "POST", headers: { "x-provision-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify({ installId }) });
    const { carToken } = (await reg.json()) as { carToken: string };
    const ses = await fetch(`${b.base}/v1/sessions`, { method: "POST", headers: { authorization: `Bearer ${carToken}` } });
    const { wsTicket } = (await ses.json()) as { wsTicket: string };
    const { promise, resolve } = Promise.withResolvers<WebSocket>();
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/v1/talk?ticket=${wsTicket}`);
    ws.onopen = () => resolve(ws);
    const car = new Car(b.base, carToken, await promise);
    car.send({ type: "hello", v: 1, appVersion: "t" });
    return car;
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  ctx(c: Record<string, unknown>) { this.send({ type: "ctx", ctx: c }); }
  api(method: string, path: string, body?: unknown) {
    return fetch(this.base + path, { method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async until(pred: (f: Frame[]) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred(this.frames)) {
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await Bun.sleep(10);
    }
  }
  async say(text: string, id: string, ctx: Record<string, unknown> = { gear: "P", speedKmh: 0 }) {
    this.send({ type: "turn.start", turnId: id, trigger: "ptt" });
    this.send({ type: "ctx", turnId: id, ctx });
    this.send({ type: "text", turnId: id, text });
    this.send({ type: "turn.end", turnId: id });
    await this.until((f) => f.some((x) => x.turnId === id && (x.type === "reply.end" || x.type === "error")));
    return this.frames.find((x) => x.turnId === id && x.type === "reply.end")?.text ?? "";
  }
  async memory(): Promise<{ id: string; kind: string; text: string }[]> {
    return ((await (await this.api("GET", "/v1/memory?limit=50")).json()) as { items: { id: string; kind: string; text: string }[] }).items;
  }
  async consent(type: string, granted = true) {
    await this.api("POST", "/v1/consents", { type, version: "1", granted, channel: "car" });
  }
  /** C1 의 필수 동의: 녹음과 외부 AI 처리. */
  async grantTalk() {
    await this.consent("record");
    await this.consent("external_ai");
  }
  close() { this.ws.close(); }
}

const newLlm = (): Llm => ({ replies: [], extraction: "NONE", calls: [], extractCalls: 0 });
/** 첫 만남은 끝난 차(기본값). 이벤트 시험이 질문에 가로막히지 않게 한다. */
async function readyCar(llm: Llm, tts = false) {
  const car = await Car.connect(boot(llm, tts));
  await car.grantTalk();
  await car.consent("memory");
  return car;
}
const proactives = (car: Car) => car.frames.filter((f) => f.type === "proactive");
const drive = { gear: "D", speedKmh: 40, naviGuiding: false };

describe("LLM deadline (PLEOS-134)", () => {
  test("a stream that stalls after the first token ends the turn with error llm_failed and the next turn is accepted", async () => {
    const car = await Car.connect(boot(newLlm(), false, undefined, { llmDeadlineMs: 150, stall: true }));
    await car.grantTalk();
    await car.consent("memory");
    await car.say("오늘 날씨 어때?", "d1");
    expect(car.frames.find((f) => f.turnId === "d1" && f.type === "error")?.code).toBe("llm_failed");
    expect(car.frames.some((f) => f.turnId === "d1" && f.type === "reply.end")).toBe(false);
    await car.say("다시 물어볼게", "d2");
    expect(car.frames.find((f) => f.turnId === "d2" && f.type === "error")?.code).toBe("llm_failed");
    car.close();
  });
});

describe("proactive decision", () => {
  test("wiper turning on while driving: proactive frame, then reply on the same id (AC-4.3-05)", async () => {
    const car = await readyCar(newLlm(), true);
    car.ctx({ ...drive, wiper: "off" });
    car.ctx({ ...drive, wiper: "low" });
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    const p = proactives(car)[0]!;
    expect(p.reason).toBe("wiper");
    const idx = car.frames.findIndex((f) => f.type === "proactive");
    expect(car.frames.slice(idx + 1).every((f) => f.turnId === p.id)).toBe(true);
    expect(car.frames.find((f) => f.type === "reply.end")?.text).toContain("비");
    car.close();
  });

  test("never while naviGuiding=true", async () => {
    const car = await readyCar(newLlm());
    car.ctx({ ...drive, wiper: "off", naviGuiding: true });
    car.ctx({ ...drive, wiper: "low", naviGuiding: true });
    await Bun.sleep(200);
    expect(car.frames).toEqual([]);
    car.close();
  });

  test("settings.proactive=off: the same event stays silent (AC-4.3-06, AC-4.7-01)", async () => {
    const car = await readyCar(newLlm());
    expect((await car.api("PATCH", "/v1/settings", { proactive: "off" })).status).toBe(200);
    car.ctx({ ...drive, wiper: "off" });
    car.ctx({ ...drive, wiper: "low" });
    await Bun.sleep(200);
    expect(proactives(car)).toEqual([]);
    await car.api("PATCH", "/v1/settings", { proactive: "normal" });
    car.ctx({ ...drive, wiper: "off" });
    car.ctx({ ...drive, wiper: "low" });
    await car.until((f) => f.some((x) => x.type === "proactive"));
    car.close();
  });

  test("minimum interval between spoken events and once per reason per trip", async () => {
    const car = await readyCar(newLlm());
    car.ctx({ gear: "N", speedKmh: 0 });
    car.ctx({ gear: "P", speedKmh: 0, doorOpen: false, wiper: "off" });
    car.ctx({ gear: "P", speedKmh: 0, doorOpen: false, wiper: "low" });
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    await Bun.sleep(30);
    // 같은 주행의 다른 이벤트(문 열림)는 10분 간격 안이라 조용하다.
    car.ctx({ gear: "P", speedKmh: 0, doorOpen: true, wiper: "low" });
    await Bun.sleep(200);
    expect(proactives(car).map((p) => p.reason)).toEqual(["wiper"]);
    car.close();
  });

  test("low range at P speaks with the fuel type: EV says 충전, gasoline says 주유", async () => {
    for (const [fuel, word] of [[10, "충전"], [1, "주유"]] as const) {
      const car = await readyCar(newLlm());
      car.ctx({ gear: "N", speedKmh: 0 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 200, fuelType: fuel });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 30, fuelType: fuel });
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      expect(car.frames.find((f) => f.type === "reply.end")?.text).toContain(word);
      car.close();
    }
  });

  test("arrival: P for 3 s after driving speaks once; going back to D first cancels it", async () => {
    const car = await readyCar(newLlm());
    car.ctx({ gear: "D", speedKmh: 30 });
    car.ctx({ gear: "P", speedKmh: 0 });
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    expect(proactives(car).map((p) => p.reason)).toEqual(["arrival"]);
    expect(car.frames.find((f) => f.type === "reply.end")?.text).toContain("도착");
    car.close();

    const car2 = await Car.connect(boot(newLlm()), "install-0002");
    await car2.grantTalk();
    car2.ctx({ gear: "D", speedKmh: 30 });
    car2.ctx({ gear: "P", speedKmh: 0 });
    car2.ctx({ gear: "D", speedKmh: 20 });
    await Bun.sleep(200);
    expect(proactives(car2)).toEqual([]);
    car2.close();
  });

  test("F2: a new car's first P asks speech, then nickname, then chat level; answers become settings", async () => {
    const car = await Car.connect(boot(newLlm()));
    await car.grantTalk();
    car.ctx({ gear: "P", speedKmh: 0 });
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    expect(proactives(car)[0]!.reason).toBe("meet");
    expect(car.frames.find((f) => f.type === "reply.end")?.text).toContain("어떻게 말하면 좋을지");
    expect(await car.say("존댓말로 해 줘", "a1")).toContain("뭐라고 불러 드리면 좋을까요?");
    expect(await car.say("민수라고 불러 줘", "a2")).toContain("얼마나 말을 걸면 좋을지");
    await car.say("자주 말해 줘", "a3");
    const s = (await (await car.api("GET", "/v1/settings")).json()) as { speech: string; nickname: string; proactive: string };
    expect(s).toMatchObject({ speech: "jondaetmal", nickname: "민수", proactive: "high" });
    car.close();
  });

  test("F3: after the first meeting there is no second greeting the same day, but the next day greets with the default line", async () => {
    const real = new SystemClock();
    let offset = 0;
    const shifted: Clock = { now: () => real.now() + offset, setTimeout: (f, ms) => real.setTimeout(f, ms), clearTimeout: (h) => real.clearTimeout(h) };
    const b = boot(newLlm(), false, shifted);
    const first = await Car.connect(b);
    await first.grantTalk();
    first.ctx({ gear: "P", speedKmh: 0 });
    await first.until((f) => f.some((x) => x.type === "reply.end"));
    await first.say("편하게 해", "g1");
    await first.say("됐어", "g2");
    await first.say("적당히", "g3");
    first.close();
    const same = await Car.connect(b);
    same.ctx({ gear: "P", speedKmh: 0 });
    await Bun.sleep(150);
    expect(proactives(same)).toEqual([]);
    same.close();
    offset = 26 * 3_600_000;
    const next = await Car.connect(b);
    next.ctx({ gear: "P", speedKmh: 0 });
    await next.until((f) => f.some((x) => x.type === "reply.end"));
    expect(proactives(next).map((p) => p.reason)).toEqual(["greeting"]);
    expect(next.frames.find((f) => f.type === "reply.end")?.text).toBe("안녕! 오늘은 어디 가?");
    next.close();
  });

  test("voice speech change pushes a settings frame (phone/car sync)", async () => {
    const car = await readyCar(newLlm());
    await car.say("존댓말 써 줘", "s1");
    await car.until((f) => f.some((x) => x.type === "settings" && x.settings?.speech === "jondaetmal"));
    car.close();
  });
});

describe("memory", () => {
  test("AC-4.4-14: after a turn a MemoryItem exists and the raw transcript is not stored; AC-4.4-11: the next answer's prompt carries it", async () => {
    const llm = newLlm();
    llm.extraction = "FACT: 내일 면접이 있다";
    const car = await readyCar(llm);
    const said = "내일 면접 보러 가는데 너무 떨리네";
    await car.say(said, "m1");
    for (let i = 0; i < 100 && (await car.memory()).length === 0; i++) await Bun.sleep(20);
    const items = await car.memory();
    expect(items.map((m) => m.text)).toEqual(["내일 면접이 있다"]);
    expect(JSON.stringify(items)).not.toContain(said);
    await car.say("면접 얘기 좀 더 해 줘", "m2");
    expect(llm.calls.at(-1)!.system).toContain("내일 면접이 있다");
    car.close();
  });

  test("memoryEnabled=false: nothing is written and nothing is recalled (AC-4.7-03)", async () => {
    const llm = newLlm();
    llm.extraction = "FACT: 내일 면접이 있다";
    const car = await readyCar(llm);
    await car.api("PATCH", "/v1/settings", { memoryEnabled: false });
    await car.say("내일 면접 보러 가는데 너무 떨리네", "m1");
    await Bun.sleep(150);
    expect(llm.extractCalls).toBe(0);
    expect(await car.memory()).toEqual([]);
    car.close();
  });

  test("without memory consent nothing is written", async () => {
    const llm = newLlm();
    llm.extraction = "FACT: 내일 면접이 있다";
    const car = await Car.connect(boot(llm));
    await car.grantTalk();
    await car.say("내일 면접 보러 가는데 너무 떨리네", "m1");
    await Bun.sleep(150);
    expect(llm.extractCalls).toBe(0);
    expect(await car.memory()).toEqual([]);
    car.close();
  });

  test("withdrawal leaves nothing: items gone at once and later turns write nothing", async () => {
    const llm = newLlm();
    llm.extraction = "FACT: 내일 면접이 있다";
    const car = await readyCar(llm);
    await car.say("내일 면접 보러 가는데 너무 떨리네", "m1");
    for (let i = 0; i < 100 && (await car.memory()).length === 0; i++) await Bun.sleep(20);
    expect((await car.api("DELETE", "/v1/consents/memory")).status).toBe(204);
    expect(await car.memory()).toEqual([]);
    llm.extractCalls = 0;
    await car.say("오늘은 비가 오네 그래서 천천히 갈게", "m2");
    await Bun.sleep(150);
    expect(await car.memory()).toEqual([]);
    expect(llm.calls.at(-1)!.system).not.toContain("내일 면접이 있다");
    car.close();
  });

  test("voice deletion: '면접 얘기 잊어줘' deletes the matching item and confirms; no LLM call", async () => {
    const llm = newLlm();
    const car = await readyCar(llm);
    await car.api("POST", "/v1/memory", {}); // 없는 경로는 무시
    // 기억 시드는 대화로: 추출이 하나 만든다
    llm.extraction = "FACT: 내일 면접이 있다";
    await car.say("내일 면접 보러 가는데 너무 떨리네", "m1");
    for (let i = 0; i < 100 && (await car.memory()).length === 0; i++) await Bun.sleep(20);
    const before = llm.calls.length;
    const reply = await car.say("면접 얘기 잊어줘", "m2");
    expect(reply).toContain("잊었");
    expect(await car.memory()).toEqual([]);
    expect(llm.calls.length).toBe(before);
    car.close();
  });

  test("voice deletion is refused while driving", async () => {
    const llm = newLlm();
    llm.extraction = "FACT: 내일 면접이 있다";
    const car = await readyCar(llm);
    await car.say("내일 면접 보러 가는데 너무 떨리네", "m1");
    for (let i = 0; i < 100 && (await car.memory()).length === 0; i++) await Bun.sleep(20);
    const reply = await car.say("면접 얘기 잊어줘", "m2", { gear: "D", speedKmh: 50 });
    expect(reply).toContain("운전 중");
    expect((await car.memory()).length).toBe(1);
    car.close();
  });
});

describe("consent gate (AC-4.9-05, PLEOS-135)", () => {
  test("baseline P before C1: the first-meeting question comes once both consents arrive on the live socket", async () => {
    const car = await Car.connect(boot(newLlm()));
    car.ctx({ gear: "P", speedKmh: 0 });
    await Bun.sleep(100); // negative check: nothing may arrive before consent
    expect(proactives(car)).toEqual([]);
    await car.consent("record");
    expect(proactives(car)).toEqual([]);
    await car.consent("external_ai");
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    expect(proactives(car).map((p) => p.reason)).toEqual(["meet"]);
    car.close();
  });

  test("a car with no consent: turn -> consent_required, no LLM call, no proactive", async () => {
    const llm = newLlm();
    const car = await Car.connect(boot(llm, true));
    car.ctx({ gear: "P", speedKmh: 0 });
    await Bun.sleep(200);
    expect(proactives(car)).toEqual([]);
    await car.say("안녕 오늘 날씨 어때", "c1");
    expect(car.frames.find((f) => f.turnId === "c1")).toEqual({ type: "error", code: "consent_required", turnId: "c1" });
    expect(llm.calls.length).toBe(0);
    expect(llm.extractCalls).toBe(0);
    car.close();
  });

  test("record alone is not enough: external_ai is required too", async () => {
    const llm = newLlm();
    const car = await Car.connect(boot(llm));
    await car.consent("record");
    await car.say("안녕 오늘 날씨 어때", "c1");
    expect(car.frames.find((f) => f.turnId === "c1")?.code).toBe("consent_required");
    expect(llm.calls.length).toBe(0);
    car.close();
  });

  test("withdrawal while connected stops the next turn and the next proactive", async () => {
    const llm = newLlm();
    const car = await readyCar(llm);
    expect(await car.say("안녕 오늘 날씨 어때", "c1")).not.toBe("");
    const calls = llm.calls.length;
    expect((await car.api("DELETE", "/v1/consents/external_ai")).status).toBe(204);
    await car.say("또 물어볼게 오늘 뭐 하지", "c2");
    expect(car.frames.find((f) => f.turnId === "c2")?.code).toBe("consent_required");
    expect(llm.calls.length).toBe(calls);
    car.ctx({ gear: "D", speedKmh: 40, wiper: "off" });
    car.ctx({ gear: "D", speedKmh: 40, wiper: "on" });
    await Bun.sleep(200);
    expect(proactives(car)).toEqual([]);
    car.close();
  });
});

describe("safety (AC-4.4-15)", () => {
  test("a forbidden request is answered in character without calling the LLM", async () => {
    const llm = newLlm();
    const car = await readyCar(llm);
    const reply = await car.say("술 마시고 운전해도 되지?", "x1");
    expect(reply).toContain("대리");
    expect(llm.calls.length).toBe(0);
    const reply2 = await car.say("신호 무시하고 그냥 지나가자 과속으로", "x2");
    expect(reply2).toContain("그건 같이 못 해");
    car.close();
  });

  test("unsafe model output is cut and replaced with a topic change", async () => {
    const llm = newLlm();
    llm.replies = ["좋아. 속도 더 올려서 가자! 신나게."];
    const car = await readyCar(llm);
    const reply = await car.say("오늘 기분 좋다", "x1");
    expect(reply).not.toContain("올려");
    expect(reply).toContain("다른 얘기");
    car.close();
  });

  test("input rules: negated mentions pass, plain chat passes", () => {
    expect(checkInput("술 마시고 운전하면 안 되는 거지?", "banmal")).toBeNull();
    expect(checkInput("오늘 날씨 어때", "banmal")).toBeNull();
    expect(checkInput("죽고 싶다", "banmal")?.line).toContain("109");
    expect(checkOutput("보고 싶었어!", false)).toBe("drop");
    expect(checkOutput("화면을 눌러 봐", true)).toBe("drop");
  });
});

describe("intents and latency helpers", () => {
  test("speech / nickname / forget / chat parsing", () => {
    expect(parseSpeechChange("존댓말 써줘")).toBe("jondaetmal");
    expect(parseSpeechChange("반말 해줘")).toBe("banmal");
    expect(parseSpeechChange("존댓말 쓰지 마")).toBeNull();
    expect(answerNickname("됐어")).toBeNull();
    expect(answerNickname("민수")).toBe("민수");
    expect(answerChat("가끔")).toBe("low");
    expect(parseForget("그거 잊어줘")).toEqual({ kind: "it" });
    expect(parseForget("전부 다 잊어줘")).toEqual({ kind: "all" });
    expect(parseForget("면접 얘기 잊어줘")).toEqual({ kind: "topic", topic: "면접" });
    expect(parseForget("오늘 뭐 먹지")).toBeNull();
  });

  test("first clause is cut at a comma once it has >= 8 chars, later pieces wait for sentence ends", () => {
    const s = new SentenceSplitter({ firstClauseMin: 8 });
    expect(s.push("비 오는 날에는, 천천히 가")).toEqual(["비 오는 날에는,"]);
    expect(s.push("는 게 좋아. 조심해")).toEqual(["천천히 가는 게 좋아."]);
    const t = new SentenceSplitter({ firstClauseMin: 8 });
    expect(t.push("응, 맞아. 그래")).toEqual(["응, 맞아."]);
  });

  test("first piece is cut at the last space once it has >= firstWordsMin chars even without comma or sentence end", () => {
    const s = new SentenceSplitter({ firstClauseMin: 8, firstWordsMin: 12 });
    expect(s.push("오늘 하루 어땠는지 정말 궁금")).toEqual(["오늘 하루 어땠는지 정말"]);
    expect(s.push("해서 물어봤어. 너는")).toEqual(["궁금해서 물어봤어."]);
  });
});
