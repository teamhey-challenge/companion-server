import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getProvider, parseStream } from "../src/llm/providers";
import { talkHandlers, validateTurn } from "../src/talk";
import { Observability } from "../src/observe";

const req = { model: "m-1", system: "SYS", userText: "안녕", maxTokens: 123 };

// 임의 크기로 쪼갠 바이트 스트림(멀티바이트 한글이 청크 경계에서 잘리는 경우 포함)
async function* chunks(file: string, size = 7) {
  const b = new TextEncoder().encode(readFileSync(`${import.meta.dir}/fixtures/${file}`, "utf8"));
  for (let i = 0; i < b.length; i += size) yield b.slice(i, i + size);
}
async function collect(name: string, file: string, size?: number) {
  let s = "";
  for await (const d of parseStream(getProvider(name), chunks(file, size))) s += d;
  return s;
}

describe("request building", () => {
  test("anthropic", () => {
    const r = getProvider("anthropic").buildRequest(req, "KEY");
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.headers["x-api-key"]).toBe("KEY");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.body).toEqual({ model: "m-1", max_tokens: 123, stream: true, system: "SYS", messages: [{ role: "user", content: "안녕" }] });
  });
  test("openai", () => {
    const r = getProvider("openai").buildRequest(req, "KEY");
    expect(r.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(r.headers.authorization).toBe("Bearer KEY");
    expect(r.body).toEqual({
      model: "m-1", max_completion_tokens: 123, stream: true,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "안녕" }],
    });
  });
  test("gemini", () => {
    const r = getProvider("gemini").buildRequest(req, "KEY");
    expect(r.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/m-1:streamGenerateContent?alt=sse");
    expect(r.headers["x-goog-api-key"]).toBe("KEY");
    expect(r.url).not.toContain("KEY");
    expect(r.body).toEqual({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [{ role: "user", parts: [{ text: "안녕" }] }],
      generationConfig: { maxOutputTokens: 123 },
    });
  });
  test("openai-compatible", () => {
    const r = getProvider("openai-compatible").buildRequest({ ...req, baseUrl: "http://gw:1/v1/" }, "KEY");
    expect(r.url).toBe("http://gw:1/v1/chat/completions");
    expect(r.headers.authorization).toBe("Bearer KEY");
    expect(r.body).toEqual({
      model: "m-1", max_tokens: 123, stream: true,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "안녕" }],
    });
    expect(() => getProvider("openai-compatible").buildRequest(req, "KEY")).toThrow("LLM_BASE_URL");
  });
  test("unknown provider", () => expect(() => getProvider("x")).toThrow());
});

describe("stream parsing", () => {
  for (const [name, file] of [["anthropic", "anthropic.sse"], ["openai", "openai.sse"], ["openai-compatible", "openai.sse"], ["gemini", "gemini.sse"]] as const) {
    test(name, async () => {
      expect(await collect(name, file)).toBe("안녕하세요!");
      expect(await collect(name, file, 1)).toBe("안녕하세요!");
      expect(await collect(name, file, 100000)).toBe("안녕하세요!");
    });
  }
  test("anthropic error event throws", async () => {
    async function* bad() {
      yield new TextEncoder().encode('data: {"type":"error","error":{"message":"overloaded"}}\n\n');
    }
    await expect(async () => { for await (const _ of parseStream(getProvider("anthropic"), bad())); }).toThrow("overloaded");
  });
});

describe("turn validation", () => {
  test("ok", () => expect(validateTurn('{"type":"turn","text":"hi","ctx":{"speedKph":0}}')).toEqual({ ok: true, text: "hi" }));
  test("rejects location", () => {
    expect(validateTurn('{"type":"turn","text":"hi","ctx":{"lat":37.5}}')).toEqual({ ok: false, code: "location_not_accepted" });
    expect(validateTurn('{"type":"turn","text":"hi","ctx":{"GPS":"x"}}')).toEqual({ ok: false, code: "location_not_accepted" });
  });
  test("rejects bad input", () => {
    expect(validateTurn("nope")).toEqual({ ok: false, code: "bad_json" });
    expect(validateTurn('{"type":"x"}')).toEqual({ ok: false, code: "bad_turn" });
    expect(validateTurn(JSON.stringify({ type: "turn", text: "a".repeat(501) }))).toEqual({ ok: false, code: "text_too_long" });
  });
});

describe("openai-compatible model", () => {
  test("resolved model from stream chunk", async () => {
    const meta: { model?: string } = {};
    async function* body() {
      yield new TextEncoder().encode('data: {"model":"keepalive"}\n\ndata: {"model":"claude-haiku-4-5","choices":[{"delta":{"content":"네"}}]}\n\ndata: [DONE]\n\n');
    }
    let s = "";
    for await (const d of parseStream(getProvider("openai-compatible"), body(), meta)) s += d;
    expect(s).toBe("네");
    expect(meta.model).toBe("claude-haiku-4-5");
  });
});

describe("talk handler", () => {
  const cfg = { providerName: "openai-compatible", model: "chat-fast", apiKey: undefined, baseUrl: "http://x/v1", maxTokens: 10 };
  const mk = () => {
    const sent: string[] = [];
    let closed: number | undefined;
    return { sent, ws: { send: (s: string) => void sent.push(s), close: (c?: number) => void (closed = c) }, closed: () => closed };
  };
  const h = talkHandlers(cfg, new Observability(() => {}));
  test("binary frame -> close 1003", async () => {
    const c = mk();
    await h.message(c.ws, new Uint8Array([1, 2, 3]));
    expect(c.closed()).toBe(1003);
    expect(c.sent).toEqual([]);
  });
  test("location key rejected, no key error", async () => {
    const a = mk();
    await h.message(a.ws, '{"type":"turn","text":"hi","ctx":{"lat":1}}');
    expect(JSON.parse(a.sent[0]!).code).toBe("location_not_accepted");
    const b2 = mk();
    await h.message(b2.ws, '{"type":"turn","text":"hi"}');
    expect(JSON.parse(b2.sent[0]!).code).toBe("no_key");
  });
});
