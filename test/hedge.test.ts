import { describe, expect, test } from "bun:test";
import { hedged, type HedgeLeg } from "../src/llm/hedge";
import { Observability } from "../src/observe";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))), { once: true });
  });

async function collect(it: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const d of it) s += d;
  return s;
}

describe("hedged", () => {
  test("slow first leg: second leg wins, loser aborted", async () => {
    const calls: Array<{ aborted: () => boolean }> = [];
    const attempt = async function* (leg: HedgeLeg) {
      const n = calls.push({ aborted: () => leg.signal.aborted });
      leg.meta.model = `m${n}`;
      await sleep(n === 1 ? 500 : 5, leg.signal);
      yield `a${n}`;
      yield "!";
    };
    const meta: { model?: string } = {};
    const t0 = performance.now();
    expect(await collect(hedged(attempt, 30, new AbortController().signal, meta))).toBe("a2!");
    expect(performance.now() - t0).toBeLessThan(300);
    expect(meta.model).toBe("m2");
    expect(calls[0]!.aborted()).toBe(true);
  });

  test("fast first leg: no second request", async () => {
    let n = 0;
    const attempt = async function* (leg: HedgeLeg) {
      n++;
      leg.meta.model = "m";
      yield "ok";
    };
    expect(await collect(hedged(attempt, 50, new AbortController().signal))).toBe("ok");
    await Bun.sleep(80);
    expect(n).toBe(1);
  });

  test("first leg errors early: retried once, both failing throws", async () => {
    let n = 0;
    // eslint-disable-next-line require-yield
    const bad = async function* (): AsyncGenerator<string> {
      n++;
      throw new Error(`boom${n}`);
    };
    await expect(collect(hedged(bad, 1000, new AbortController().signal))).rejects.toThrow("boom1");
    expect(n).toBe(2);
    n = 0;
    const flaky = async function* (): AsyncGenerator<string> {
      if (++n === 1) throw new Error("x");
      yield "fine";
    };
    expect(await collect(hedged(flaky, 1000, new AbortController().signal))).toBe("fine");
  });
});

describe("latency summary", () => {
  test("p50/p95 over ring", () => {
    const lines: string[] = [];
    const o = new Observability((l) => lines.push(l));
    for (let i = 1; i <= 60; i++) o.turn({ llmFirstTokenMs: i * 10, firstTtsByteMs: i === 1 ? null : i * 20, totalMs: i * 30, model: i % 2 ? "a" : "b" });
    const s = o.latency();
    expect(s.n).toBe(50);
    expect(s.llmFirstTokenMs).toEqual({ p50: 350, p95: 580 });
    expect(s.models).toEqual({ a: 25, b: 25 });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ev: "talk.timing", llm_first_token_ms: 600, first_tts_byte_ms: 1200, total_ms: 1800, model: "b" });
  });
});
