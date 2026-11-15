/**
 * 안전 필터·페르소나 평가(PRD §7.8, AC-4.4-15). 진짜 LLM 경로(OmniRoute chat-fast, 텍스트만, TTS 없음)로
 * test/fixtures/safety-eval.json 의 프롬프트를 /v1/talk 웹소켓에 보내고 답을 규칙 + LLM 심판으로 채점한다.
 *   bun scripts/safety-eval.ts [--out /tmp/safety-eval.json] [--only id,id]
 * 키는 ~/.config/companion/server.env 에서만 읽고 출력하지 않는다.
 */
import { Observability } from "../src/observe";
import { createServer } from "../src/server";
import { loadTalkConfig } from "../src/talk";
import { getProvider, streamLlm } from "../src/llm/providers";
import { buildJudgeSystem, scoreReply, type EvalCase, type Judged, type Verdict } from "./eval-rules";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const outPath = arg("--out") ?? "/tmp/safety-eval.json";
const only = arg("--only")?.split(",");
const all = JSON.parse(await Bun.file(new URL("../test/fixtures/safety-eval.json", import.meta.url)).text()) as EvalCase[];
const cases = all.filter((c) => !only || only.includes(c.id));

const talk = loadTalkConfig();
if (!talk.apiKey) throw new Error("no LLM key");
const server = createServer({
  port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath: ":memory:",
  guard: { trustProxy: false, turnsPerMin: 10_000, turnsPerDay: 100_000, upgradesPerMin: 10_000, httpPerMin: 10_000 },
  tts: null,
});
const base = `http://127.0.0.1:${server.port}`;

async function ask(c: EvalCase, n: number): Promise<{ text: string; ms: number }> {
  const installId = `eval-install-${String(n).padStart(4, "0")}`;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const { carToken } = (await (await call("POST", "/v1/cars/register", {}, { installId })).json()) as { carToken: string };
  const auth = { authorization: `Bearer ${carToken}` };
  for (const type of ["record", "external_ai", "memory"]) await call("POST", "/v1/consents", auth, { type, version: "1", granted: true, channel: "car" });
  await call("PATCH", "/v1/settings", auth, { speech: c.speech });
  const { wsTicket } = (await (await call("POST", "/v1/sessions", auth)).json()) as { wsTicket: string };
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/talk?ticket=${wsTicket}`);
  const frames: { type: string; text?: string; code?: string }[] = [];
  ws.onmessage = (e) => {
    if (typeof e.data === "string") frames.push(JSON.parse(e.data));
  };
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  await opened.promise;
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  send({ type: "hello", v: 1, appVersion: "eval" });
  const ctx = c.driving ? { gear: "D", speedKmh: 60, naviGuiding: false } : { gear: "P", speedKmh: 0 };
  const t0 = performance.now();
  send({ type: "turn.start", turnId: "t1", trigger: "ptt" });
  send({ type: "ctx", turnId: "t1", ctx });
  send({ type: "text", turnId: "t1", text: c.text });
  send({ type: "turn.end", turnId: "t1" });
  const end = Date.now() + 30_000;
  while (!frames.some((f) => f.type === "reply.end" || f.type === "error") && Date.now() < end) await Bun.sleep(20);
  const ms = Math.round(performance.now() - t0);
  ws.close();
  const err = frames.find((f) => f.type === "error");
  if (err) return { text: `[ERROR ${err.code}]`, ms };
  return { text: frames.find((f) => f.type === "reply.end")?.text ?? "[NO REPLY]", ms };
}

async function judge(c: EvalCase, reply: string): Promise<Judged> {
  const user = `[운전자 말] ${c.text}\n[상태] ${c.driving ? "주행 중" : "정차 중"}\n[헤이리 답] ${reply}`;
  let out = "";
  for await (const d of streamLlm(getProvider(talk.providerName), { model: talk.model, system: buildJudgeSystem(c), userText: user, maxTokens: 300, baseUrl: talk.baseUrl }, talk.apiKey!)) out += d;
  const m = out.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m?.[0] ?? "{}") as { refused?: boolean; ok?: boolean; why?: string };
    return { refused: !!j.refused, ok: !!j.ok, why: String(j.why ?? "") };
  } catch {
    return { refused: false, ok: false, why: `judge parse fail: ${out.slice(0, 80)}` };
  }
}

type Row = EvalCase & { reply: string; ms: number } & Verdict;
const results: Row[] = [];
let n = 0;
for (const c of cases) {
  n++;
  const { text, ms } = await ask(c, n);
  const j = await judge(c, text);
  const v = scoreReply(c, text, j);
  results.push({ ...c, reply: text, ms, ...v });
  console.log(`${v.pass ? "PASS" : "FAIL"} ${c.id} [${c.expect}→${v.refused ? "refused" : "answered"}] ${text.slice(0, 80)}${v.pass ? "" : `  !! ${v.problems.join("; ")}`}`);
}
await Bun.write(outPath, JSON.stringify(results, null, 1));

const cnt = (f: (r: Row) => boolean) => results.filter(f).length;
const sub = (e: Row["expect"]) => results.filter((r) => r.expect === e);
console.log("\n=== confusion (expect → actual) ===");
console.log(`expect refuse : refused ${cnt((r) => r.expect === "refuse" && r.refused)} / answered(MISSED) ${cnt((r) => r.expect === "refuse" && !r.refused)}`);
console.log(`expect normal : refused(FALSE REFUSAL) ${cnt((r) => r.expect === "normal" && r.refused)} / answered ${cnt((r) => r.expect === "normal" && !r.refused)}`);
console.log(`expect rules  : refused ${cnt((r) => r.expect === "rules" && r.refused)} / answered ${cnt((r) => r.expect === "rules" && !r.refused)}`);
console.log(`pass ${cnt((r) => r.pass)}/${results.length} = ${((100 * cnt((r) => r.pass)) / results.length).toFixed(1)}%  (refuse ${sub("refuse").filter((r) => r.pass).length}/${sub("refuse").length}, rules ${sub("rules").filter((r) => r.pass).length}/${sub("rules").length}, normal ${sub("normal").filter((r) => r.pass).length}/${sub("normal").length})`);
console.log(`avg latency ${Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length)} ms`);
await server.stop(true);
process.exit(0);
