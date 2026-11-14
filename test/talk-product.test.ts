import { afterEach, describe, expect, test } from "bun:test";
import { SystemClock, type Clock } from "../src/clock";
import { Observability } from "../src/observe";
import { createServer, type RunningServer } from "../src/server";
import { FakeTts } from "../src/tts";
import { checkInput, checkOutput } from "../src/safety";
import { parseForget, parseSpeechChange, answerNickname, answerChat } from "../src/intents";
import { SentenceSplitter } from "../src/tts";
import { SentenceCap } from "../src/sentence-cap";

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 50 };

let servers: RunningServer[] = [];
afterEach(() => {
  for (const s of servers) void s.stop(true);
  servers = [];
});

interface Frame { type: string; turnId?: string; id?: string; reason?: string; text?: string; settings?: { speech: string }; status?: string; code?: string }

const sse = (text: string) =>
  `${[...text].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`).join("")}data: [DONE]\n\n`;

interface Llm { replies: string[]; extraction: string; calls: { system: string; user: string }[]; extractCalls: number; /** 도착·첫 인사 프롬프트에 대한 답(없으면 NONE). delayMs 만큼 늦게 첫 글자를 보낸다. */ proactive?: (system: string) => string; proactiveDelayMs?: number }

function boot(llm: Llm, tts = false, clock?: Clock, extra: { llmDeadlineMs?: number; stall?: boolean; stallAfter?: string; proactiveLlmFirstMs?: number } = {}) {
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:",
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 100, turnsPerDay: 1000, upgradesPerMin: 100, httpPerMin: 1000 },
    arrivalDelayMs: 30,
    clock,
    llmDeadlineMs: extra.llmDeadlineMs,
    proactiveLlmFirstMs: extra.proactiveLlmFirstMs,
    tts: tts ? new FakeTts() : null,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      if (extra.stallAfter) {
        // 문장을 몇 개 보낸 뒤 멈추는 공급사: 서버가 문장 상한에서 스트림을 끊어야 턴이 끝난다.
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: extra.stallAfter } }] })}\n\n`));
            init.signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
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
      const isProactive = system.includes("먼저 말 걸기: arrival") || system.includes("먼저 말 걸기: greeting");
      if (isProactive && llm.proactiveDelayMs) await Bun.sleep(llm.proactiveDelayMs);
      const text = isProactive ? (llm.proactive?.(system) ?? "NONE") : (llm.replies.shift() ?? "그렇구나, 좋아!");
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

describe("sentence cap (PLEOS-125)", () => {
  const long = "오늘 날씨 좋다. 같이 드라이브하니까 기분 좋아. 점심은 뭐 먹을까? 국밥도 좋고 떡볶이도 좋아. 어떤 게 땡겨? 말해 줘!";
  const park = { gear: "P", speedKmh: 0 };

  test("driving: the reply stops after the 2nd sentence; deltas, reply.end and the next prompt all carry only what was said", async () => {
    const llm = newLlm();
    llm.replies = [long, "그래!"];
    const car = await readyCar(llm, true);
    const text = await car.say("안녕", "c1", drive);
    expect(text).toBe("오늘 날씨 좋다. 같이 드라이브하니까 기분 좋아.");
    const deltas = car.frames.filter((f) => f.turnId === "c1" && f.type === "reply.delta").map((f) => f.text).join("");
    expect(deltas).toBe(text);
    await car.say("다음", "c2", drive);
    expect(llm.calls.at(-1)!.system).toContain("같이 드라이브하니까 기분 좋아.");
    expect(llm.calls.at(-1)!.system).not.toContain("점심은 뭐 먹을까");
    car.close();
  });

  test("parked: capped at 4 sentences; a shorter reply is untouched", async () => {
    const llm = newLlm();
    llm.replies = [long, "응, 좋아! 같이 가자."];
    const car = await readyCar(llm);
    expect(await car.say("점심 어때", "p1", park)).toBe("오늘 날씨 좋다. 같이 드라이브하니까 기분 좋아. 점심은 뭐 먹을까? 국밥도 좋고 떡볶이도 좋아.");
    expect(await car.say("그래", "p2", park)).toBe("응, 좋아! 같이 가자.");
    car.close();
  });

  test("output filter sees banned phrases that straddle an early first-chunk boundary (normal reply: 속도 / 올려서)", async () => {
    for (const text of ["비 오는 날엔 속도 올려서 달리자!", "오늘은 기분이 좋아서 신호 무시하고 가자!"]) {
      const llm = newLlm();
      llm.replies = [text];
      const car = await readyCar(llm, true);
      const said = await car.say("안녕", "b1", drive);
      const deltas = car.frames.filter((f) => f.turnId === "b1" && f.type === "reply.delta").map((f) => f.text).join("");
      expect(said).not.toMatch(/속도|신호/);
      expect(deltas).not.toMatch(/속도|신호/);
      car.close();
    }
  });

  test("mid-stream: the provider stalls after sentence 2, the server cuts the stream and ends the turn at once", async () => {
    const car = await Car.connect(boot(newLlm(), false, undefined, { stallAfter: "첫 번째 문장이야. 두 번째 문장이야. 세 번째는", llmDeadlineMs: 2500 }));
    await car.grantTalk();
    const t0 = performance.now();
    const text = await car.say("안녕", "m1", drive);
    expect(text).toBe("첫 번째 문장이야. 두 번째 문장이야.");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(car.frames.some((f) => f.turnId === "m1" && f.type === "error")).toBe(false);
    car.close();
  });
});

describe("output filter: lectures and things the app cannot do (PLEOS-125)", () => {
  test("checkOutput classifies lecture / cant-do / ok", () => {
    expect(checkOutput("비 오니까 천천히 가자.", true)).toBe("drop");
    expect(checkOutput("안전운전 해!", true)).toBe("drop");
    expect(checkOutput("조심해서 운전해.", true)).toBe("drop");
    expect(checkOutput("가까운 주유소 찾아볼까?", true)).toBe("cant");
    expect(checkOutput("맛집 검색해 줄게!", false)).toBe("cant");
    expect(checkOutput("근처 주유소를 찾아 들러 보는 게 좋겠어.", true)).toBe("cant");
    expect(checkOutput("길 안내해 줄까?", true)).toBe("cant");
    expect(checkOutput("비 오는 날엔 잔잔한 노래가 좋아.", true)).toBe("ok");
    expect(checkOutput("천천히 가자", true, "천천히 가는 게 좋을까?")).toBe("ok"); // 운전자가 물었으면 허용
    expect(checkOutput("나는 찾아보기 어려운 노래를 알아.", true)).toBe("ok");
  });

  test("a lecture sentence is removed before counting: the 2 sentences left are the useful ones", async () => {
    const llm = newLlm();
    llm.replies = ["비 오네. 천천히 가자. 와이퍼가 돌고 있어. 노래 틀까?"];
    const car = await readyCar(llm);
    const text = await car.say("비 와", "f1", drive);
    expect(text).toBe("비 오네. 와이퍼가 돌고 있어.");
    car.close();
  });

  test("a cant-do offer is dropped; when nothing else is left the honest line is said", async () => {
    const llm = newLlm();
    llm.replies = ["가까운 주유소 찾아볼까?", "국밥 어때? 근처 식당 검색해 줄게."];
    const car = await readyCar(llm);
    expect(await car.say("기름 없어", "k1", drive)).toBe("나는 검색이나 길 안내는 못 해, 그래도 얘기는 같이 할 수 있어!");
    expect(await car.say("점심 뭐 먹지", "k2", drive)).toBe("국밥 어때?");
    car.close();
  });

  test("the user asked about driving slowly -> the answer may say it", async () => {
    const llm = newLlm();
    llm.replies = ["비 오면 천천히 가는 게 좋지."];
    const car = await readyCar(llm);
    expect(await car.say("비 올 때 천천히 가야 해?", "a1", drive)).toBe("비 오면 천천히 가는 게 좋지.");
    car.close();
  });
});

describe("SentenceCap unit", () => {
  test("counts ? ! … and newline ends, ignores dots inside a sentence", () => {
    const cap = new SentenceCap(2);
    expect(cap.take("그래 3.5km 가자.")).toEqual({ text: "그래 3.5km 가자.", done: false });
    expect(cap.take("어때? 응!")).toEqual({ text: "어때?", done: true });
    expect(cap.take("더 있어")).toEqual({ text: null, done: true });
  });
  test("a piece split mid-sentence (clause cut) does not count as a sentence", () => {
    const cap = new SentenceCap(2);
    expect(cap.take("비 오니까,")).toEqual({ text: "비 오니까,", done: false });
    expect(cap.take("천천히 가자.")).toEqual({ text: "천천히 가자.", done: false });
    expect(cap.take("좋아!")).toEqual({ text: "좋아!", done: true });
  });
});

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

  describe("scenario 2 (PLEOS-168): range vs the navigation destination, and 'later'", () => {
    const lowEv = (car: Car, extra: Record<string, unknown> = {}) => {
      car.ctx({ gear: "N", speedKmh: 0 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 200, fuelType: 10, ...extra });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 30, fuelType: 10, ...extra });
    };
    const lastText = (car: Car) => [...car.frames].reverse().find((f) => f.type === "reply.end")?.text ?? "";

    test("with a destination: compares the distances and asks per fuel type", async () => {
      for (const [fuel, word] of [[10, "충전 들를래?"], [1, "주유 들를래?"], [7, "충전소 들를래?"]] as const) {
        const car = await readyCar(newLlm());
        car.ctx({ gear: "N", speedKmh: 0 });
        car.ctx({ gear: "P", speedKmh: 0, rangeKm: 200, fuelType: fuel, destKm: 42 });
        car.ctx({ gear: "P", speedKmh: 0, rangeKm: 30, fuelType: fuel, destKm: 42 });
        await car.until((f) => f.some((x) => x.type === "reply.end"));
        expect(lastText(car)).toBe(`목적지까지 42km인데 남은 거리가 30km야. 가는 길에 ${word}`);
        car.close();
      }
    });

    test("with a destination: 60 km of range is short for a 90 km trip, 200 km is fine for 42 km", async () => {
      const car = await readyCar(newLlm());
      car.ctx({ gear: "N", speedKmh: 0 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 200, fuelType: 10, destKm: 90 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 60, fuelType: 10, destKm: 90 });
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      expect(lastText(car)).toContain("목적지까지 90km인데 남은 거리가 60km");
      car.close();
      const ok = await Car.connect(boot(newLlm()), "install-0003");
      await ok.grantTalk();
      await ok.consent("memory");
      ok.ctx({ gear: "N", speedKmh: 0 });
      ok.ctx({ gear: "P", speedKmh: 0, rangeKm: 400, fuelType: 10, destKm: 42 });
      ok.ctx({ gear: "P", speedKmh: 0, rangeKm: 200, fuelType: 10, destKm: 42 });
      await Bun.sleep(200);
      expect(proactives(ok)).toEqual([]);
      ok.close();
    });

    test("without a destination: the non-assuming line, nothing about a destination", async () => {
      const car = await readyCar(newLlm());
      lowEv(car);
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      expect(lastText(car)).toBe("남은 거리가 좀 빠듯해. 출발 전에 충전 들를래?");
      car.close();
    });

    /** A car whose clock can be moved: the 6 s quiet time after a spoken reply must pass before the next stop. */
    const shiftedCar = async (installId: string) => {
      const real = new SystemClock();
      const shift = { ms: 0 };
      const clock: Clock = { now: () => real.now() + shift.ms, setTimeout: (f, ms) => real.setTimeout(f, ms), clearTimeout: (h) => real.clearTimeout(h) };
      const car = await Car.connect(boot(newLlm(), false, clock), installId);
      await car.grantTalk();
      await car.consent("memory");
      return { car, shift };
    };

    test("'later' is remembered: the next parked stop reminds once, then it is cleared", async () => {
      const { car, shift } = await shiftedCar("install-0010");
      lowEv(car, { destKm: 42 });
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      expect(await car.say("이따가 할래", "l1", { gear: "P", speedKmh: 0, rangeKm: 30, fuelType: 10, destKm: 42 })).toContain("한 번 더 챙겨 줄게");
      shift.ms += 20_000;
      car.ctx({ gear: "D", speedKmh: 40, rangeKm: 30, fuelType: 10 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 28, fuelType: 10 });
      await car.until((f) => f.filter((x) => x.type === "proactive").length === 2);
      expect(proactives(car).map((p) => p.reason)).toEqual(["range", "reminder"]);
      await car.until((f) => f.filter((x) => x.type === "reply.end").length === 3);
      expect(lastText(car)).toBe("아까 충전 들르기로 한 거 기억해?");
      // a third stop: the reminder is gone, the ordinary arrival line comes back and nothing repeats the reminder
      shift.ms += 20_000;
      car.ctx({ gear: "D", speedKmh: 40, rangeKm: 28, fuelType: 10 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 26, fuelType: 10 });
      await Bun.sleep(300);
      expect(proactives(car).map((p) => p.reason).filter((r) => r === "reminder")).toHaveLength(1);
      car.close();
    });

    test("not 'later' (a plain answer, or a refusal) sets no reminder", async () => {
      for (const answer of ["응 들를게", "아니 안 들를래"]) {
        const car = await readyCar(newLlm());
        lowEv(car);
        await car.until((f) => f.some((x) => x.type === "reply.end"));
        await car.say(answer, "n1", { gear: "P", speedKmh: 0, rangeKm: 30, fuelType: 10 });
        car.ctx({ gear: "D", speedKmh: 40, rangeKm: 30, fuelType: 10 });
        car.ctx({ gear: "P", speedKmh: 0, rangeKm: 28, fuelType: 10 });
        await Bun.sleep(300);
        expect(proactives(car).map((p) => p.reason)).not.toContain("reminder");
        car.close();
      }
    });

    test("'later' said to anything else than the stop question is not a reminder", async () => {
      const car = await readyCar(newLlm());
      await car.say("나중에 얘기하자", "x1", { gear: "P", speedKmh: 0 });
      car.ctx({ gear: "D", speedKmh: 40 });
      car.ctx({ gear: "P", speedKmh: 0 });
      await Bun.sleep(300);
      expect(proactives(car).map((p) => p.reason)).not.toContain("reminder");
      car.close();
    });

    test("D-14: while navigation guides nothing is said; the reminder waits for a stop without guidance", async () => {
      const { car, shift } = await shiftedCar("install-0011");
      lowEv(car, { destKm: 42 });
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      await car.say("나중에 할게", "d1", { gear: "P", speedKmh: 0, rangeKm: 30, fuelType: 10, destKm: 42 });
      shift.ms += 20_000;
      car.ctx({ gear: "D", speedKmh: 40, rangeKm: 30, fuelType: 10, naviGuiding: true });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 28, fuelType: 10, naviGuiding: true });
      await Bun.sleep(300);
      expect(proactives(car).map((p) => p.reason)).toEqual(["range"]);
      car.ctx({ gear: "D", speedKmh: 40, rangeKm: 28, fuelType: 10, naviGuiding: false });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 26, fuelType: 10, naviGuiding: false });
      await car.until((f) => f.filter((x) => x.type === "proactive").length === 2);
      expect(proactives(car).map((p) => p.reason)).toEqual(["range", "reminder"]);
      car.close();
    });

    test("if the range is plentiful again at the next stop (charged), the reminder is dropped silently", async () => {
      const car = await readyCar(newLlm());
      lowEv(car);
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      await car.say("이따가 할래", "r1", { gear: "P", speedKmh: 0, rangeKm: 30, fuelType: 10 });
      car.ctx({ gear: "D", speedKmh: 40, rangeKm: 30, fuelType: 10 });
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 320, fuelType: 10 });
      await Bun.sleep(300);
      expect(proactives(car).map((p) => p.reason)).not.toContain("reminder");
      car.close();
    });
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

  test("F2: the first ctx has no gear yet (the car's gear listener answers late), then P -> the first meeting still starts", async () => {
    const car = await Car.connect(boot(newLlm()));
    await car.consent("record");
    await car.consent("external_ai");
    car.ctx({ speedKmh: 0, naviGuiding: false });
    car.ctx({ gear: "P", speedKmh: 0, naviGuiding: false });
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    expect(proactives(car).map((p) => p.reason)).toEqual(["meet"]);
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

  describe("H1: memory-based arrival and first-boarding lines (PLEOS-167)", () => {
    const ARRIVE = "도착했네! 오늘 면접 잘 보고 와, 끝나고 어땠는지 알려 줘!";
    const ASK = "어제 면접 어땠어?";
    const park = { gear: "P", speedKmh: 0 };

    /** 첫 만남을 끝내고 말한 사실 하나를 기억으로 남긴 차 + 움직이는 시계. */
    async function carWithFact(llm: Llm, extra: { proactiveLlmFirstMs?: number } = {}) {
      const real = new SystemClock();
      const t = { offset: 0 };
      const shifted: Clock = { now: () => real.now() + t.offset, setTimeout: (f, ms) => real.setTimeout(f, ms), clearTimeout: (h) => real.clearTimeout(h) };
      const b = boot(llm, false, shifted, extra);
      const car = await Car.connect(b);
      await car.grantTalk();
      await car.consent("memory");
      car.ctx(park);
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      await car.say("편하게 해", "h1");
      await car.say("됐어", "h2");
      await car.say("적당히", "h3");
      llm.extraction = "FACT: 오늘 면접 보러 간다";
      await car.say("나 오늘 면접 보러 가", "h4");
      for (let i = 0; i < 200 && (await car.memory()).length === 0; i++) await Bun.sleep(20); // the extraction is a background call; poll the real store
      expect((await car.memory()).map((m) => m.text)).toEqual(["오늘 면접 보러 간다"]);
      car.close();
      return { b, t };
    }
    const arrive = async (b: { base: string; port: number | undefined }) => {
      const car = await Car.connect(b);
      car.ctx({ gear: "D", speedKmh: 30 });
      car.ctx(park);
      await car.until((f) => f.some((x) => x.type === "reply.end"));
      return car;
    };

    test("proactive arrival: a banned phrase straddling the early first-chunk boundary is not spoken", async () => {
      const llm = newLlm();
      llm.proactive = () => "비 오는 날엔 속도 올려서 달리자!";
      const { b } = await carWithFact(llm);
      const car = await arrive(b);
      const end = car.frames.find((f) => f.type === "reply.end")!.text!;
      const deltas = car.frames.filter((f) => f.type === "reply.delta").map((f) => f.text).join("");
      expect(end).not.toContain("속도");
      expect(deltas).not.toContain("속도");
      car.close();
    });

    test("arrival: a memory said today makes the model's line (with 오늘 말함 in the prompt), spoken once and cap-limited", async () => {
      const llm = newLlm();
      llm.proactive = () => `${ARRIVE} 힘내! 화이팅! 잘 될 거야!`;
      const { b } = await carWithFact(llm);
      const car = await arrive(b);
      expect(proactives(car).map((p) => p.reason)).toEqual(["arrival"]);
      const said = car.frames.find((f) => f.type === "reply.end")!.text!;
      expect(said.startsWith(ARRIVE)).toBe(true);
      expect(said.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(4); // parked cap
      expect(llm.calls.at(-1)!.system).toContain("오늘 말함: 오늘 면접 보러 간다");
      car.close();
    });

    test("next boarding the day after: first P asks about yesterday's item (어제 말함 in the prompt)", async () => {
      const llm = newLlm();
      llm.proactive = (s) => (s.includes("먼저 말 걸기: greeting") && s.includes("어제 말함: 오늘 면접 보러 간다") ? ASK : "NONE");
      const { b, t } = await carWithFact(llm);
      t.offset = 24 * 3_600_000 + 60_000; // same KST time of day, next day: always exactly "어제"
      const next = await Car.connect(b);
      next.ctx(park);
      await next.until((f) => f.some((x) => x.type === "reply.end"));
      expect(proactives(next).map((p) => p.reason)).toEqual(["greeting"]);
      expect(next.frames.find((f) => f.type === "reply.end")?.text).toBe(ASK);
      next.close();
    });

    test("NONE from the model -> the fixed lines (arrival today, greeting next day)", async () => {
      const llm = newLlm(); // proactive undefined -> NONE
      const { b, t } = await carWithFact(llm);
      const car = await arrive(b);
      expect(car.frames.find((f) => f.type === "reply.end")?.text).toContain("도착");
      expect(car.frames.find((f) => f.type === "reply.end")?.text).not.toContain("면접");
      car.close();
      t.offset = 26 * 3_600_000;
      const next = await Car.connect(b);
      next.ctx(park);
      await next.until((f) => f.some((x) => x.type === "reply.end"));
      expect(next.frames.find((f) => f.type === "reply.end")?.text).toBe("안녕! 오늘은 어디 가?");
      next.close();
    });

    test("a slow model (no first character in time) -> the fixed line, not silence", async () => {
      const llm = newLlm();
      llm.proactive = () => ARRIVE;
      llm.proactiveDelayMs = 600; // the fake provider really is slow here; fake timers cannot delay a fetch
      const { b } = await carWithFact(llm, { proactiveLlmFirstMs: 100 });
      const car = await arrive(b);
      const text = car.frames.find((f) => f.type === "reply.end")!.text!;
      expect(text).toContain("도착");
      expect(text).not.toContain("면접");
      car.close();
    });

    test("a memory older than 3 days is not offered to the model: fixed line, no proactive LLM call", async () => {
      const llm = newLlm();
      llm.proactive = () => ARRIVE;
      const { b, t } = await carWithFact(llm);
      t.offset = 5 * 86_400_000;
      const before = llm.calls.length;
      const next = await Car.connect(b);
      next.ctx(park);
      await next.until((f) => f.some((x) => x.type === "reply.end"));
      expect(next.frames.find((f) => f.type === "reply.end")?.text).toBe("안녕! 오늘은 어디 가?");
      expect(llm.calls.length).toBe(before);
      next.close();
    });

    test("D-14: navi guiding -> no arrival line at all, memory or not", async () => {
      const llm = newLlm();
      llm.proactive = () => ARRIVE;
      const { b } = await carWithFact(llm);
      const before = llm.calls.length;
      const car = await Car.connect(b);
      car.ctx({ gear: "D", speedKmh: 30, naviGuiding: true });
      car.ctx({ gear: "P", speedKmh: 0, naviGuiding: true });
      await Bun.sleep(300); // real wait: asserting that nothing happens past the 30 ms arrival delay
      expect(proactives(car)).toEqual([]);
      expect(llm.calls.length).toBe(before);
      car.close();
    });
  });

  test("voice speech change pushes a settings frame (phone/car sync)", async () => {
    const car = await readyCar(newLlm());
    await car.say("존댓말 써 줘", "s1");
    await car.until((f) => f.some((x) => x.type === "settings" && x.settings?.speech === "jondaetmal"));
    car.close();
  });

  test("PLEOS-158: a phone unpair pushes a pairing(none) frame to the car's open socket", async () => {
    const car = await readyCar(newLlm());
    const { pairCode } = (await (await car.api("POST", "/v1/pairings")).json()) as { pairCode: string };
    const claim = await fetch(`${car.base}/v1/pairings/${pairCode}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record: true, memory: true }) });
    const { phoneToken } = (await claim.json()) as { phoneToken: string };
    expect(car.frames.some((f) => f.type === "pairing")).toBe(false);
    const del = await fetch(`${car.base}/v1/pairings/current`, { method: "DELETE", headers: { authorization: `Bearer ${phoneToken}` } });
    expect(del.status).toBe(204);
    await car.until((f) => f.some((x) => x.type === "pairing" && x.status === "none"));
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

  test("PLEOS-174: the same sentence extracted again (even as another kind) is not stored twice", async () => {
    const llm = newLlm();
    llm.extraction = "FACT: 퇴근길에는 조용한 대화를 좋아해요";
    const car = await readyCar(llm);
    await car.say("퇴근길에는 조용히 가는 게 좋아", "d1");
    for (let i = 0; i < 100 && (await car.memory()).length === 0; i++) await Bun.sleep(20);
    llm.extraction = "SUMMARY: 퇴근길에는 조용한 대화를 좋아해요.";
    llm.extractCalls = 0;
    await car.say("퇴근할 때는 말 없이 가고 싶어", "d2");
    for (let i = 0; i < 100 && llm.extractCalls === 0; i++) await Bun.sleep(20);
    await Bun.sleep(100);
    expect((await car.memory()).map((m) => m.text)).toEqual(["퇴근길에는 조용한 대화를 좋아해요"]);
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
  test("withdrawing external_ai cancels the in-flight turn at once (PLEOS-135)", async () => {
    const car = await Car.connect(boot(newLlm(), false, undefined, { llmDeadlineMs: 60_000, stall: true }));
    await car.grantTalk();
    car.send({ type: "turn.start", turnId: "w1", trigger: "ptt" });
    car.send({ type: "ctx", turnId: "w1", ctx: { gear: "P", speedKmh: 0 } });
    car.send({ type: "text", turnId: "w1", text: "오늘 날씨 어때?" });
    car.send({ type: "turn.end", turnId: "w1" });
    await car.until((f) => f.some((x) => x.type === "reply.start" && x.turnId === "w1")); // the stalled stream has started
    expect((await car.api("DELETE", "/v1/consents/external_ai")).status).toBe(204);
    await car.until((f) => f.some((x) => x.turnId === "w1" && x.type === "error"));
    expect(car.frames.find((x) => x.turnId === "w1" && x.type === "error")?.code).toBe("consent_required");
    car.close();
  });

  test("withdrawing record clears the pending arrival timer: it never speaks (PLEOS-135)", async () => {
    const real = new SystemClock();
    const pending = new Map<number, () => void>();
    let next = 1;
    const clock: Clock = {
      now: () => real.now(),
      // 도착 타이머만 손으로 돌린다(다른 타이머는 실제로 돈다).
      setTimeout: (f, ms) => {
        if (ms !== 30) return real.setTimeout(f, ms);
        pending.set(next, f);
        return { id: next++ };
      },
      clearTimeout: (h) => {
        if (pending.has(h.id)) pending.delete(h.id);
        else real.clearTimeout(h);
      },
    };
    const car = await Car.connect(boot(newLlm(), true, clock));
    await car.grantTalk();
    car.ctx({ gear: "D", speedKmh: 40 });
    car.ctx({ gear: "P", speedKmh: 0 });
    for (let i = 0; i < 100 && pending.size === 0; i++) await Bun.sleep(10);
    expect(pending.size).toBe(1); // arrival timer armed
    expect((await car.api("DELETE", "/v1/consents/record")).status).toBe(204);
    expect(pending.size).toBe(0); // cleared by the withdrawal
    car.close();
  });

  test("consent arriving long after the baseline P ctx (fake clock +90 s, then +10 min) still gets the first-meeting question", async () => {
    const real = new SystemClock();
    let offset = 0;
    const shifted: Clock = { now: () => real.now() + offset, setTimeout: (f, ms) => real.setTimeout(f, ms), clearTimeout: (h) => real.clearTimeout(h) };
    for (const jump of [90_000, 600_000]) {
      const car = await Car.connect(boot(newLlm(), false, shifted), `install-late${jump}`);
      car.ctx({ gear: "P", speedKmh: 0 }); // baseline P, consent still missing
      await Bun.sleep(80); // negative check: nothing before consent
      expect(proactives(car)).toEqual([]);
      offset += jump; // the driver spends a long time on C1
      car.ctx({ gear: "P", speedKmh: 0, rangeKm: 300 }); // an ordinary ctx update while C1 is open
      await car.consent("record");
      await car.consent("external_ai");
      await car.until((f) => f.some((x) => x.type === "proactive" && x.reason === "meet"), 4000);
      car.close();
    }
  });

  test("consent first, then the baseline ctx: the first-meeting question still comes (order-independent)", async () => {
    const car = await Car.connect(boot(newLlm()));
    await car.grantTalk();
    car.ctx({ gear: "P", speedKmh: 0 });
    await car.until((f) => f.some((x) => x.type === "reply.end"));
    expect(proactives(car).map((p) => p.reason)).toEqual(["meet"]);
    car.close();
  });

  test("a refused first stop (turn busy) is retried and the question still comes", async () => {
    const car = await Car.connect(boot(newLlm()));
    car.send({ type: "turn.start", turnId: "b1", trigger: "ptt" }); // an open turn makes startProactive refuse
    car.ctx({ gear: "P", speedKmh: 0 });
    await car.grantTalk();
    await Bun.sleep(100); // negative check: refused while the turn is open
    expect(proactives(car)).toEqual([]);
    car.send({ type: "turn.cancel", turnId: "b1" });
    await car.until((f) => f.some((x) => x.type === "proactive" && x.reason === "meet"), 4000);
    car.close();
  });

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
