import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type RunningServer } from "../src/server";
import { Observability } from "../src/observe";
import { L, pick } from "../src/lines";
import { AudioPipeline, BreezeTts, FakeTts, GatedTts, PhraseCache, Semaphore, SentenceSplitter, loadTtsConfig, TtsError, type TtsProvider } from "../src/tts";

describe("SentenceSplitter", () => {
  test("splits at sentence ends and keeps the tail for flush", () => {
    const s = new SentenceSplitter();
    expect(s.push("안녕하세요! 오늘 비 ")).toEqual(["안녕하세요!"]);
    expect(s.push("오네요. 천천히 가")).toEqual(["오늘 비 오네요."]);
    expect(s.flush()).toEqual(["천천히 가"]);
  });
  test("short fragments merge into the next sentence", () => {
    const s = new SentenceSplitter();
    expect(s.push("네. 알겠어요, 그렇게 할게요.")).toEqual(["네. 알겠어요, 그렇게 할게요."]);
  });
  test("decimal points do not split", () => {
    const s = new SentenceSplitter();
    expect(s.push("주행가능거리는 3.5km 남았어요.")).toEqual(["주행가능거리는 3.5km 남았어요."]);
  });
});

describe("AudioPipeline", () => {
  const run = async (tts: TtsProvider, sentences: string[], limit = 2) => {
    const ac = new AbortController();
    const events: string[] = [];
    const gated = new GatedTts(tts, new Semaphore(limit), new Observability(() => {}));
    const p = new AudioPipeline(gated, ac.signal, {
      onStart: (ok) => events.push(ok ? "start" : "none"),
      onChunk: (c, filler) => events.push(`${filler ? "f" : "chunk"}${c[0]}`),
      onError: () => events.push("error"),
    });
    for (const s of sentences) p.add(s);
    p.finish();
    await p.done;
    return events;
  };

  test("chunks arrive in sentence order after a single start", async () => {
    const fake = new FakeTts();
    expect(await run(fake, ["첫 문장입니다.", "둘째 문장입니다."])).toEqual(["start", "chunk1", "chunk2", "chunk3", "chunk1", "chunk2", "chunk3"]);
    expect(fake.calls).toEqual(["첫 문장입니다.", "둘째 문장입니다."]);
  });
  test("at most 2 generations at once", async () => {
    const fake = new FakeTts(5);
    await run(fake, ["문장 하나입니다.", "문장 둘입니다.", "문장 셋입니다.", "문장 넷입니다."]);
    expect(fake.calls.length).toBe(4);
    expect(fake.maxActive).toBe(2);
  });
  test("gate keeps generations at 2 and logs queue wait", async () => {
    const lines: string[] = [];
    const fake = new FakeTts(5);
    const gated = new GatedTts(fake, new Semaphore(2), new Observability((l) => lines.push(l)));
    const ac = new AbortController();
    await Promise.all(["하나입니다.", "둘입니다요.", "셋입니다요.", "넷입니다요."].map(async (s) => { for await (const _ of await gated.synth(s, ac.signal)) void _; }));
    expect(fake.maxActive).toBe(2);
    expect(lines.some((l) => l.includes('"tts.queue_wait"'))).toBe(true);
  });
  test("phrase cache: primed phrase is served from memory without a provider call or gate slot, LRU bounded", async () => {
    const fake = new FakeTts();
    const cache = new PhraseCache(new GatedTts(fake, new Semaphore(1), new Observability(() => {})), "v1", 3 * 480 * 2);
    expect(await cache.prime(["음… 잠깐만!"])).toMatchObject({ done: 1, failed: 0, entries: 1, bytes: 1440 });
    expect(cache.cached("음… 잠깐만!")).toBe(true);
    const got: number[] = [];
    for await (const c of await cache.synth("음… 잠깐만!", new AbortController().signal)) got.push(c[0]!);
    expect(got).toEqual([1, 2, 3]);
    expect(fake.calls).toEqual(["음… 잠깐만!"]);
    // 프라임 목록에 없는 문장은 담지 않는다
    for await (const _ of await cache.synth("LLM 이 만든 문장", new AbortController().signal)) void _;
    expect(cache.cached("LLM 이 만든 문장")).toBe(false);
    // 한도(2문장분)를 넘으면 가장 오래 안 쓴 것부터 버린다
    await cache.prime(["둘째 문장입니다.", "셋째 문장입니다."]);
    expect(cache.size.entries).toBe(2);
    expect(cache.cached("음… 잠깐만!")).toBe(false);
  });
  test("prime stops after two failures in a row", async () => {
    const bad: TtsProvider = {
      async synth() {
        throw new TtsError(402, "x");
      },
    };
    const cache = new PhraseCache(bad, "v1");
    expect(await cache.prime(["하나입니다.", "둘입니다요.", "셋입니다요."])).toMatchObject({ done: 0, failed: 2 });
  });
  test("first sentence failing -> none, later sentences are not requested", async () => {
    const calls: string[] = [];
    const bad: TtsProvider = {
      async synth(t) {
        calls.push(t);
        throw new TtsError(402, "no credits");
      },
    };
    expect(await run(bad, ["첫 문장입니다."])).toEqual(["error", "none"]);
  });
  test("no sentences -> none", async () => {
    expect(await run(new FakeTts(), [])).toEqual(["none"]);
  });
});

describe("loadTtsConfig", () => {
  test("provider selection", () => {
    expect(loadTtsConfig({ COMPANION_TTS_PROVIDER: "fake", COMPANIONX: "1" }).provider).toBe("fake");
    expect(loadTtsConfig({ COMPANION_TTS_PROVIDER: "off", BREEZE_API_KEY: "k", COMPANION_SECRETS_FILE: "/nonexistent" }).provider).toBe("off");
    expect(loadTtsConfig({ BREEZE_API_KEY: "k", COMPANION_SECRETS_FILE: "/nonexistent" }).provider).toBe("breeze");
  });
});

describe("BreezeTts", () => {
  const cfg = { provider: "breeze" as const, apiKey: "k", voiceId: "voc_old", sampleFile: `${import.meta.dir}/fixtures/openai.sse` };
  const obs = new Observability(() => {});
  const pcm = () => new Response(new Uint8Array([1, 0, 2, 0]));

  test("request shape: stream pcm, xi-api-key, no instructions", async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return pcm();
    }) as unknown as typeof fetch;
    const out: Uint8Array[] = [];
    for await (const c of await new BreezeTts(cfg, obs, f).synth("안녕하세요", new AbortController().signal)) out.push(c);
    expect(seen[0]?.url).toBe("https://api.breeze.blue/v1/text-to-speech/voc_old/stream?output_format=pcm");
    expect(seen[0]?.headers["xi-api-key"]).toBe("k");
    expect(seen[0]?.body).toEqual({ text: "안녕하세요", model_id: "breeze-tts-2-multilingual", language_code: "ko", voice_settings: { use_speaker_boost: true } });
    expect(out.length).toBeGreaterThan(0);
  });

  test("404 recreates the voice exactly once", async () => {
    const urls: string[] = [];
    let ttsCalls = 0;
    const f = (async (url: string) => {
      urls.push(url.replace("https://api.breeze.blue", ""));
      if (url.includes("/text-to-speech/")) return ++ttsCalls === 1 ? new Response("gone", { status: 404 }) : pcm();
      if (url.endsWith("/clone")) return Response.json({ generated_voice_id: "gen1" });
      return Response.json({ voice_id: "voc_new" });
    }) as unknown as typeof fetch;
    const b = new BreezeTts(cfg, obs, f);
    for await (const _ of await b.synth("문장입니다", new AbortController().signal));
    expect(urls).toEqual([
      "/v1/text-to-speech/voc_old/stream?output_format=pcm",
      "/v1/voice-previews/clone",
      "/v1/voice-previews/gen1/save",
      "/v1/text-to-speech/voc_new/stream?output_format=pcm",
    ]);
    const again = new BreezeTts(cfg, obs, (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch);
    await again.synth("a", new AbortController().signal).catch(() => undefined);
    await expect(again.synth("a", new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  });

  test("non-2xx -> TtsError", async () => {
    const b = new BreezeTts(cfg, obs, (async () => new Response("no", { status: 402 })) as unknown as typeof fetch);
    await expect(b.synth("a", new AbortController().signal)).rejects.toMatchObject({ status: 402 });
  });
});

describe("server with TTS", () => {
  let servers: RunningServer[] = [];
  afterEach(() => {
    for (const s of servers) void s.stop(true);
    servers = [];
  });

  const deltas = (parts: string[]) =>
    `${parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("")}data: [DONE]\n\n`;

  async function turn(tts: TtsProvider | null, body: string, cancelAfterFirstBinary = false) {
    const fetchImpl = (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const s = createServer({
      port: 0,
      hostname: "127.0.0.1",
      talk: { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 },
      guard: { provisionSecret: "p", trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 100 },
      observer: new Observability(() => {}),
      dbPath: ":memory:",
      tts,
      fetchImpl,
    });
    servers.push(s);
    const base = `http://127.0.0.1:${s.port}`;
    const j = { "content-type": "application/json" };
    const { carToken } = (await (await fetch(`${base}/v1/cars/register`, { method: "POST", headers: { ...j, "X-Provision-Secret": "p" }, body: JSON.stringify({ installId: "install-0001" }) })).json()) as { carToken: string };
    const { wsTicket } = (await (await fetch(`${base}/v1/sessions`, { method: "POST", headers: { Authorization: `Bearer ${carToken}` } })).json()) as { wsTicket: string };
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/v1/talk?ticket=${wsTicket}`);
    ws.binaryType = "arraybuffer";
    const order: string[] = [];
    const bytes: number[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        order.push("bin");
        bytes.push((e.data as ArrayBuffer).byteLength);
        if (cancelAfterFirstBinary && order.filter((o) => o === "bin").length === 1) ws.send(JSON.stringify({ type: "turn.cancel", turnId: "t1" }));
        return;
      }
      const f = JSON.parse(e.data) as { type: string; audio?: unknown };
      order.push(f.type === "reply.start" ? `start:${typeof f.audio === "string" ? f.audio : "pcm"}` : f.type);
      if (f.type === "reply.end" || f.type === "error") resolve();
    };
    ws.onopen = () => {
      for (const f of [
        { type: "hello", v: 1, appVersion: "t" },
        { type: "turn.start", turnId: "t1", trigger: "ptt" },
        { type: "text", turnId: "t1", text: "안녕" },
        { type: "turn.end", turnId: "t1" },
      ]) ws.send(JSON.stringify(f));
    };
    if (cancelAfterFirstBinary) await Bun.sleep(400);
    else await promise;
    ws.close();
    return { order, bytes };
  }

  const two = deltas(["안녕하세요! 오늘 날씨가 ", "좋네요. 천천히 갈까요?"]);

  test("client receives binary PCM frames between reply.start and reply.end", async () => {
    const { order, bytes } = await turn(new FakeTts(), two);
    expect(order[0]).toBe("start:pcm");
    expect(order.at(-1)).toBe("reply.end");
    expect(bytes.length).toBe(9);
    expect(bytes.every((b) => b === 480)).toBe(true);
    expect(order.indexOf("bin")).toBeGreaterThan(0);
    expect(order.filter((o) => o === "reply.delta").length).toBeGreaterThan(0);
  });

  test("turn.start pre-warms the TTS connection once per turn", async () => {
    const fake = new FakeTts();
    await turn(fake, two);
    expect(fake.warmed).toBe(1);
  });

  test("TTS off -> audio none, no binary frames", async () => {
    const { order, bytes } = await turn(null, two);
    expect(order[0]).toBe("start:none");
    expect(bytes).toEqual([]);
    expect(order.at(-1)).toBe("reply.end");
  });

  test("provider failure -> audio none, text still delivered", async () => {
    const bad: TtsProvider = {
      async synth() {
        throw new TtsError(402, "balance");
      },
    };
    const { order, bytes } = await turn(bad, two);
    expect(order[0]).toBe("start:none");
    expect(bytes).toEqual([]);
    expect(order.at(-1)).toBe("reply.end");
  });

  test("turn.cancel mid-audio stops further binary frames", async () => {
    const slow = new FakeTts(60);
    const { bytes } = await turn(slow, two, true);
    expect(bytes.length).toBeLessThan(9);
  });

  test("slow first token: a primed filler is played once, flagged separately from the real first byte", async () => {
    const fake = new FakeTts();
    const cache = new PhraseCache(new GatedTts(fake, new Semaphore(2), new Observability(() => {})), "v1");
    await cache.prime([pick(L.thinking, "banmal")]);
    const lines: string[] = [];
    const slowBody = new ReadableStream<Uint8Array>({
      async start(c) {
        await Bun.sleep(150); // 첫 토큰 지연을 흉내 내는 시험용 지연(채움말 임계 30ms 보다 길게)
        c.enqueue(new TextEncoder().encode(deltas(["안녕하세요! 반가워요."])));
        c.close();
      },
    });
    const fetchImpl = (async () => new Response(slowBody, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const s = createServer({
      port: 0,
      hostname: "127.0.0.1",
      talk: { providerName: "openai-compatible", model: "chat-fast", apiKey: "k", baseUrl: "http://llm.invalid/v1", maxTokens: 10 },
      guard: { provisionSecret: "p", trustProxy: false, turnsPerMin: 20, turnsPerDay: 300, upgradesPerMin: 100, httpPerMin: 100 },
      observer: new Observability((l) => lines.push(l)),
      dbPath: ":memory:",
      tts: cache,
      fetchImpl,
      fillerAfterMs: 30,
    });
    servers.push(s);
    const base = `http://127.0.0.1:${s.port}`;
    const j = { "content-type": "application/json" };
    const reg: { carToken: string } = await (await fetch(`${base}/v1/cars/register`, { method: "POST", headers: { ...j, "X-Provision-Secret": "p" }, body: JSON.stringify({ installId: "install-0002" }) })).json();
    const ses: { wsTicket: string } = await (await fetch(`${base}/v1/sessions`, { method: "POST", headers: { Authorization: `Bearer ${reg.carToken}` } })).json();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/v1/talk?ticket=${ses.wsTicket}`);
    ws.binaryType = "arraybuffer";
    const { promise, resolve } = Promise.withResolvers<void>();
    let bins = 0;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") bins++;
      else if (e.data.includes('"reply.end"')) resolve();
    };
    ws.onopen = () => {
      for (const f of [
        { type: "hello", v: 1, appVersion: "t" },
        { type: "turn.start", turnId: "t1", trigger: "ptt" },
        { type: "text", turnId: "t1", text: "안녕" },
        { type: "turn.end", turnId: "t1" },
      ]) ws.send(JSON.stringify(f));
    };
    await promise;
    ws.close();
    const timing: Record<string, number> = JSON.parse(lines.find((l) => l.includes('"talk.timing"'))!);
    expect(bins).toBe(9); // 채움말 3조각 + 답 두 문장 6조각
    expect(timing.filler_ms).toBeGreaterThan(0);
    expect(timing.first_audio_ms).toBe(timing.filler_ms);
    expect(timing.first_tts_byte_ms).toBeGreaterThan(timing.filler_ms!);
    expect(fake.calls.filter((c) => c === pick(L.thinking, "banmal")).length).toBe(1);
  });
});
