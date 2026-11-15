import { afterEach, describe, expect, test } from "bun:test";
import { Observability } from "../src/observe";
import { buildSystem, MEMORY_EXTRACT_SYSTEM } from "../src/llm/persona";
import { cleanOnboardingAnswer, CONSENT_FREE_STEPS, HEYRI_LINES, ONBOARDING_STEPS, onboardingPieces, parseOnboardingFrame, parseOnboardingName, WHALE_LINES } from "../src/onboarding";
import { createServer, type RunningServer } from "../src/server";
import { FakeTts, loadTtsConfig, makeTts } from "../src/tts";

const SECRET = "provision-for-tests";
const talk = { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 50 };
const GREETING = "민수야 반가워! 회사 얘기 좋아해?";

let servers: RunningServer[] = [];
afterEach(() => {
  for (const s of servers) void s.stop(true);
  servers = [];
});

const sse = (text: string) => `${[...text].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`).join("")}data: [DONE]\n\n`;

interface Boot {
  base: string;
  port: number | undefined;
  tts: FakeTts;
  prompts: string[];
}

interface BootOpts {
  /** 맞장구 LLM(고래 안내자 지시)을 어떻게 만들지. 기본은 짧은 문장 */
  ack?: (system: string, signal: AbortSignal | null | undefined) => Promise<Response>;
  tts?: FakeTts;
  ackFirstMs?: number;
}
const ACK_LINE = "출퇴근길이구나. 매일 같이 다니겠네.";

function boot(o: BootOpts = {}): Boot {
  const prompts: string[] = [];
  const tts = o.tts ?? new FakeTts();
  const s = createServer({
    port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:", tts,
    ...(o.ackFirstMs !== undefined ? { onboardingAckFirstMs: o.ackFirstMs } : {}),
    guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 100, turnsPerDay: 1000, upgradesPerMin: 100, httpPerMin: 1000 },
    fetchImpl: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      const system = body.messages[0]!.content;
      prompts.push(system);
      const stream = { headers: { "content-type": "text/event-stream" } };
      if (system.includes("고래 안내자")) return o.ack ? o.ack(system, init.signal) : new Response(sse(ACK_LINE), stream);
      return new Response(sse(system.includes("[기억 추출]") ? "NONE" : GREETING), stream);
    }) as unknown as typeof fetch,
  });
  servers.push(s);
  return { base: `http://127.0.0.1:${s.port}`, port: s.port, tts, prompts };
}

class Car {
  frames: Record<string, unknown>[] = [];
  bins = 0;
  private constructor(readonly base: string, readonly token: string, private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.frames.push(JSON.parse(e.data) as Record<string, unknown>);
      else this.bins++;
    };
  }
  static async connect(b: Boot): Promise<Car> {
    const reg = await fetch(`${b.base}/v1/cars/register`, { method: "POST", headers: { "x-provision-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify({ installId: "install-ob01" }) });
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
  api(method: string, path: string, body?: unknown) {
    return fetch(this.base + path, { method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  of(type: string) { return this.frames.filter((f) => f.type === type); }
  async until(pred: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await Bun.sleep(10);
    }
  }
  async grant(memory = true) {
    const types = memory ? ["record", "external_ai", "memory"] : ["record", "external_ai"];
    for (const type of types) await this.api("POST", "/v1/consents", { type, version: "1", granted: true, channel: "car" });
  }
  /** 단계를 말하게 하고 reply.end 까지 기다린다. */
  async step(step: string) {
    const before = this.of("reply.end").length;
    this.send({ type: "onboarding", step });
    await this.until(() => this.of("reply.end").length === before + 1);
    return this.of("reply.end").at(-1)!;
  }
  async answer(step: string, text: string) {
    const before = this.of("onboarding.ack").length;
    this.send({ type: "onboarding.answer", step, text });
    await this.until(() => this.of("onboarding.ack").length === before + 1);
    return this.of("onboarding.ack").at(-1)!;
  }
}

describe("onboarding flow on /v1/talk", () => {
  test("whale steps speak fixed lines in the whale voice, even while driving; PCM follows each onboarding frame", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    car.send({ type: "ctx", ctx: { gear: "D", speedKmh: 60 } });
    for (const step of ["whale_intro", "q1", "q2", "q3"] as const) {
      const end = await car.step(step);
      expect(end.text).toBe(WHALE_LINES[step]);
      const frame = car.of("onboarding").at(-1)!;
      expect(frame).toMatchObject({ type: "onboarding", step, text: WHALE_LINES[step] });
      expect(end.turnId).toBe(frame.id);
    }
    // the intro line is cut into two TTS pieces; what matters is that every piece used the whale voice
    expect(b.tts.voices.length).toBeGreaterThanOrEqual(4);
    expect(b.tts.voices.every((v) => v === "whale")).toBe(true);
    expect(car.bins).toBeGreaterThan(0);
    expect(car.of("error")).toEqual([]);
  });

  test("q1 name → displayName + nickname (and a settings push); q2/q3 → the driver's memory items", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    expect(await car.answer("q1", "민수라고 불러 줘")).toMatchObject({ ok: true, name: "민수" });
    const s = (await (await car.api("GET", "/v1/settings")).json()) as { displayName: string; nickname: string };
    expect(s).toMatchObject({ displayName: "민수", nickname: "민수" });
    expect(car.of("settings").length).toBeGreaterThan(0);
    expect(await car.answer("q2", "회사랑 학교 어린이집")).toMatchObject({ ok: true });
    expect(await car.answer("q3", "재밌는 옛날 이야기")).toMatchObject({ ok: true });
    const mem = ((await (await car.api("GET", "/v1/memory?limit=50")).json()) as { items: { text: string }[] }).items.map((m) => m.text);
    expect(mem).toContain("주로 다니는 곳: 회사랑 학교 어린이집");
    expect(mem).toContain("차에서 듣고 싶은 이야기: 재밌는 옛날 이야기");
  });

  test("blocked or unintelligible answers → ok:false and nothing stored", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    expect((await car.answer("q1", "씨발")).ok).toBe(false);
    expect((await car.answer("q2", "죽고 싶어")).ok).toBe(false);
    expect((await car.answer("q3", "https://evil.example/x")).ok).toBe(false);
    expect((await car.answer("q2", "")).ok).toBe(false);
    const mem = ((await (await car.api("GET", "/v1/memory?limit=50")).json()) as { items: unknown[] }).items;
    expect(mem).toEqual([]);
  });

  test("without memory consent the answers are not stored but are still used in the greeting", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant(false);
    await car.answer("q1", "민수");
    await car.answer("q2", "회사");
    expect(((await (await car.api("GET", "/v1/memory?limit=50")).json()) as { items: unknown[] }).items).toEqual([]);
    await car.step("greeting");
    expect(b.prompts.at(-1)).toContain('"회사"');
  });

  test("greeting is LLM-generated in heyri's voice (default voice) using the answers, and ends the old meet flow", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    await car.answer("q1", "민수");
    await car.answer("q2", "회사");
    await car.answer("q3", "재밌는 얘기");
    const end = await car.step("greeting");
    expect(end.text).toBe(GREETING);
    expect(b.tts.voices.at(-1)).toBeUndefined();
    const prompt = b.prompts.filter((p) => p.includes("onboarding")).at(-1)!;
    expect(prompt).toContain("이름은 민수");
    expect(prompt).toContain('"회사"');
    expect(prompt).toContain('"재밌는 얘기"');
    // heyri does not ask speech/nickname again on the next parked stop
    car.send({ type: "ctx", ctx: { gear: "D", speedKmh: 30 } });
    car.send({ type: "ctx", ctx: { gear: "P", speedKmh: 0 } });
    await Bun.sleep(150);
    expect(car.of("proactive").filter((p) => p.reason === "meet")).toEqual([]);
  });

  test("onboarding needs hello and talk consent", async () => {
    const b = boot();
    const car = await Car.connect(b);
    car.send({ type: "onboarding", step: "q1" });
    await car.until(() => car.of("error").length === 1);
    expect(car.of("error")[0]).toMatchObject({ code: "consent_required" });
  });
});

describe("D-48 script, acks, skip, consent gating", () => {
  test("whale lines match the planner mock and keep the whale name out", () => {
    expect(WHALE_LINES.whale_intro.startsWith("안녕, 나는 빛바다를 지키는 고래야.")).toBe(true);
    expect(WHALE_LINES.q1).toBe("먼저, 뭐라고 불러 줄까?");
    expect(WHALE_LINES.q3).toBe("차 안에서는 어떤 얘기가 좋아?");
    expect(WHALE_LINES.skip).toBe("괜찮아, 다음에 알려 줘.");
    expect(ONBOARDING_STEPS).toEqual(["whale_intro", "lights", "q1", "q2", "q3", "skip", "found", "greeting", "memory", "dress", "qr", "done"]);
    expect(onboardingPieces().length).toBeGreaterThan(10);
  });

  test("new whale and heyri steps speak the mock lines with the right voice, without consent", async () => {
    const b = boot();
    const car = await Car.connect(b); // no consent at all
    for (const step of ["whale_intro", "lights", "skip", "found"] as const) {
      const end = await car.step(step);
      expect(end.text).toBe(WHALE_LINES[step]);
    }
    const whaleCalls = b.tts.voices.length;
    expect(b.tts.voices.every((v) => v === "whale")).toBe(true);
    for (const step of ["dress", "qr", "done"] as const) {
      const end = await car.step(step);
      expect(end.text).toBe(HEYRI_LINES[step].banmal);
      expect(car.of("onboarding").at(-1)).toMatchObject({ step, text: HEYRI_LINES[step].banmal });
    }
    expect(b.tts.voices.slice(whaleCalls).every((v) => v === undefined)).toBe(true);
    expect(car.of("error")).toEqual([]);
    expect(b.prompts).toEqual([]); // nothing went to the LLM
  });

  test("pre-consent: intro allowed, question/greeting/answer rejected", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.step("whale_intro");
    for (const step of ["q1", "q2", "q3", "greeting"] as const) expect(CONSENT_FREE_STEPS[step]).toBeUndefined();
    car.send({ type: "onboarding", step: "q2" });
    car.send({ type: "onboarding", step: "greeting" });
    car.send({ type: "onboarding.answer", step: "q1", text: "민수", reply: true });
    await car.until(() => car.of("error").length === 3);
    expect(car.of("error").every((e) => e.code === "consent_required")).toBe(true);
    expect(car.of("onboarding.ack")).toEqual([]);
    expect(b.prompts).toEqual([]);
    const mem = ((await (await car.api("GET", "/v1/memory?limit=50")).json()) as { items: unknown[] }).items;
    expect(mem).toEqual([]);
  });

  test("memory line: remembers with memory on, never promises it with memory off", async () => {
    const on = boot();
    const carOn = await Car.connect(on);
    await carOn.grant(true);
    expect((await carOn.step("memory")).text).toBe(HEYRI_LINES.memory.banmal);

    const off = boot();
    const carOff = await Car.connect(off);
    await carOff.grant(false);
    const end = await carOff.step("memory");
    expect(end.text).toBe(HEYRI_LINES.memoryOff.banmal);
    expect(String(end.text)).toContain("기억 저장을 켜면 이렇게 기억해");
    expect(String(end.text)).not.toContain("기억해 둘게, 언제든");
  });

  test("reply:true answer → ack frame, then whale ack line in the whale voice (LLM)", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    car.send({ type: "onboarding.answer", step: "q2", text: "주로 출퇴근할 때 타", reply: true });
    await car.until(() => car.of("reply.end").length === 1);
    expect(car.of("onboarding.ack")[0]).toMatchObject({ step: "q2", ok: true });
    expect(car.of("onboarding").at(-1)).toMatchObject({ step: "ack", for: "q2" });
    expect(car.of("reply.end")[0]!.text).toBe(ACK_LINE);
    expect(b.tts.voices.length).toBeGreaterThan(0);
    expect(b.tts.voices.every((v) => v === "whale")).toBe(true);
  });

  test("without reply flag nothing is spoken after an answer (old clients unchanged)", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    await car.answer("q2", "회사");
    await Bun.sleep(100);
    expect(car.of("reply.end")).toEqual([]);
  });

  test("ack LLM slower than the limit → fixed fallback line, still whale voice", async () => {
    const b = boot({
      ackFirstMs: 80,
      ack: (_s, signal) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        return promise;
      },
    });
    const car = await Car.connect(b);
    await car.grant();
    car.send({ type: "onboarding.answer", step: "q3", text: "캠핑 얘기", reply: true });
    await car.until(() => car.of("reply.end").length === 1, 4000);
    expect(car.of("reply.end")[0]!.text).toBe("좋아, 그 얘기 많이 하자.");
    expect(b.tts.voices.every((v) => v === "whale")).toBe(true);
    expect(car.of("error")).toEqual([]);
  });

  test("ack LLM error → fixed fallback line", async () => {
    const b = boot({ ack: async () => new Response("boom", { status: 500 }) });
    const car = await Car.connect(b);
    await car.grant();
    car.send({ type: "onboarding.answer", step: "q2", text: "회사", reply: true });
    await car.until(() => car.of("reply.end").length + car.of("error").length >= 1, 4000);
    expect(car.of("reply.end")[0]!.text).toBe("그렇구나. 같이 다니자.");
  });

  test("unrecognised answer with reply:true → ok:false skipped, whale says the skip line and nothing is stored", async () => {
    const b = boot();
    const car = await Car.connect(b);
    await car.grant();
    car.send({ type: "onboarding.answer", step: "q2", text: "", reply: true });
    await car.until(() => car.of("reply.end").length === 1);
    expect(car.of("onboarding.ack")[0]).toMatchObject({ step: "q2", ok: false, skipped: true });
    expect(car.of("onboarding").at(-1)).toMatchObject({ step: "skip", text: WHALE_LINES.skip });
    expect(car.of("reply.end")[0]!.text).toBe(WHALE_LINES.skip);
    expect(b.tts.voices.every((v) => v === "whale")).toBe(true);
    expect(b.prompts).toEqual([]);
    const mem = ((await (await car.api("GET", "/v1/memory?limit=50")).json()) as { items: unknown[] }).items;
    expect(mem).toEqual([]);
  });

  test("TTS failure still delivers the onboarding frame with text and a text-only reply", async () => {
    const tts = new FakeTts();
    tts.synth = async () => {
      throw new Error("tts down");
    };
    const b = boot({ tts });
    const car = await Car.connect(b);
    const end = await car.step("whale_intro");
    expect(car.of("onboarding")[0]).toMatchObject({ step: "whale_intro", text: WHALE_LINES.whale_intro });
    expect(car.of("reply.start")[0]).toMatchObject({ audio: "none" });
    expect(end.text).toBe(WHALE_LINES.whale_intro);
  });
});

describe("onboarding helpers", () => {
  test("parseOnboardingFrame validates and ignores other frames", () => {
    expect(parseOnboardingFrame('{"type":"onboarding","step":"q1"}')).toEqual({ kind: "step", step: "q1" });
    expect(parseOnboardingFrame('{"type":"onboarding.answer","step":"q3","text":"음악"}')).toEqual({ kind: "answer", step: "q3", text: "음악", reply: false });
    expect(parseOnboardingFrame('{"type":"onboarding.answer","step":"q3","text":"음악","reply":true}')).toEqual({ kind: "answer", step: "q3", text: "음악", reply: true });
    expect(parseOnboardingFrame('{"type":"onboarding.answer","step":"greeting","text":"x"}')).toBeNull();
    expect(parseOnboardingFrame('{"type":"onboarding","step":"nope"}')).toBeNull();
    expect(parseOnboardingFrame('{"type":"ctx","ctx":{}}')).toBeNull();
    expect(parseOnboardingFrame("not json")).toBeNull();
  });
  test("names and answers", () => {
    expect(parseOnboardingName("지은이야")).toBe("지은");
    expect(parseOnboardingName("그냥 됐어")).toBeNull();
    expect(parseOnboardingName("글쎄 잘 모르겠는데 뭐라고 하지")).toBeUndefined();
    expect(cleanOnboardingAnswer("  회사랑 집.  ")).toBe("회사랑 집");
    expect(cleanOnboardingAnswer("010 1234 5678 로 와")).toBeNull();
  });
});

describe("whale voice config", () => {
  test("ONBOARDING_VOICE_ID is read from the environment/secrets and never hardcoded; unset logs the fallback once", () => {
    // loadSecrets reads process.env.COMPANION_SECRETS_FILE (not the env argument): point it at nothing so this host's real secrets file cannot leak in.
    const prev = process.env.COMPANION_SECRETS_FILE;
    process.env.COMPANION_SECRETS_FILE = "/nonexistent";
    try {
      const cfg = loadTtsConfig({ COMPANION_TTS_PROVIDER: "fake", ONBOARDING_VOICE_ID: "voc_whale_test" });
      expect(cfg.onboardingVoiceId).toBe("voc_whale_test");
      expect(loadTtsConfig({ COMPANION_TTS_PROVIDER: "fake" }).onboardingVoiceId).toBeUndefined();
      const events: string[] = [];
      makeTts(loadTtsConfig({ COMPANION_TTS_PROVIDER: "fake" }), new Observability((l) => events.push(l)));
      expect(events.join("\n")).toContain("tts.whale_voice_fallback");
      expect(events.join("\n")).not.toContain("voc_");
    } finally {
      if (prev === undefined) delete process.env.COMPANION_SECRETS_FILE;
      else process.env.COMPANION_SECRETS_FILE = prev;
    }
  });
});

describe("family (D-38, D-48)", () => {
  test("persona: several family members are addressed in turn; extraction keeps only the driver's introduction", () => {
    const sys = buildSystem({ speech: "banmal", nickname: "민수", driving: false, ctx: {}, memories: [], recent: [] });
    expect(sys).toContain("번갈아");
    expect(MEMORY_EXTRACT_SYSTEM).toContain("이름과 관계만");
    expect(MEMORY_EXTRACT_SYSTEM).toContain("동승자(특히 아이)가 한 말은 기억에서 뽑지 않는다");
  });
});
