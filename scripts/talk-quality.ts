/**
 * 일상 대화 품질 평가(PLEOS-125). 진짜 서버 경로(/v1/talk 웹소켓, OmniRoute chat-fast, 텍스트만, TTS 없음)로
 * test/fixtures/talk-quality.json 의 다중 턴 시나리오를 보내고 결정적 규칙 + LLM 심판으로 채점한다.
 *   bun scripts/talk-quality.ts [--out /tmp/talk-quality.json] [--only id,id] [--runs 1]
 * 로컬 인스턴스만 띄운다(공개 서버 아님). 키는 ~/.config/companion/server.env 에서만 읽고 출력하지 않는다.
 */
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observability } from "../src/observe";
import { createServer } from "../src/server";
import { loadTalkConfig } from "../src/talk";
import { getProvider, streamLlm } from "../src/llm/providers";
import { buildTalkJudgeSystem, scoreTalk, type TalkScenario, type TalkTurn } from "./eval-rules";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const outPath = arg("--out") ?? "/tmp/talk-quality.json";
const only = arg("--only")?.split(",");
const runs = Number(arg("--runs") ?? 1);
const all = JSON.parse(await Bun.file(new URL("../test/fixtures/talk-quality.json", import.meta.url)).text()) as TalkScenario[];
const scenarios = all.filter((c) => !only || only.includes(c.id));

const talk = loadTalkConfig();
if (!talk.apiKey) throw new Error("no LLM key");
const dbPath = join(tmpdir(), `talk-quality-${process.pid}.sqlite`);
const server = createServer({
  port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath,
  guard: { trustProxy: false, turnsPerMin: 10_000, turnsPerDay: 100_000, upgradesPerMin: 10_000, httpPerMin: 10_000 },
  tts: null,
});
const base = `http://127.0.0.1:${server.port}`;
const side = new Database(dbPath);

async function judge(sc: TalkScenario, turn: TalkTurn, reply: string, history: string): Promise<{ ok: boolean; why: string }> {
  const user = `${history}[운전자 말] ${turn.text}\n[상태] ${turn.driving ? "주행 중" : "정차 중"}\n[헤이리 답] ${reply}`;
  let out = "";
  for await (const d of streamLlm(getProvider(talk.providerName), { model: talk.model, system: buildTalkJudgeSystem(sc, turn), userText: user, maxTokens: 300, baseUrl: talk.baseUrl }, talk.apiKey!)) out += d;
  const m = out.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m?.[0] ?? "{}") as { violation?: string };
    const why = String(j.violation ?? "").trim();
    return { ok: why === "" || /위반\s*(은|이)?\s*(아님|없음)|위반 항목 없음|틀린 것으로 보지 않|위반으로 보기 어렵|분명히 어긴 것이라 보기 어렵/.test(why), why };
  } catch {
    return { ok: false, why: `judge parse fail: ${out.slice(0, 80)}` };
  }
}

interface TurnRow { sc: string; cat: string; i: number; text: string; reply: string; ms: number; problems: string[]; pass: boolean }

async function runScenario(sc: TalkScenario, n: number): Promise<TurnRow[]> {
  const installId = `tq-install-${String(n).padStart(4, "0")}`;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const { carToken } = (await (await call("POST", "/v1/cars/register", {}, { installId })).json()) as { carToken: string };
  const auth = { authorization: `Bearer ${carToken}` };
  for (const type of ["record", "external_ai", "memory"]) await call("POST", "/v1/consents", auth, { type, version: "1", granted: true, channel: "car" });
  await call("PATCH", "/v1/settings", auth, { speech: sc.speech });
  let t = Date.now() - 86_400_000;
  for (const text of sc.memories ?? []) side.query("INSERT INTO memory (id, install_id, kind, text, created_at) VALUES (?1, ?2, 'fact', ?3, ?4)").run(crypto.randomUUID(), installId, text, (t += 1000));
  const { wsTicket } = (await (await call("POST", "/v1/sessions", auth)).json()) as { wsTicket: string };
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/talk?ticket=${wsTicket}`);
  const frames: { type: string; turnId?: string; text?: string; code?: string }[] = [];
  ws.onmessage = (e) => {
    if (typeof e.data === "string") frames.push(JSON.parse(e.data));
  };
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  await opened.promise;
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  send({ type: "hello", v: 1, appVersion: "eval" });
  const rows: TurnRow[] = [];
  for (const [i, turn] of sc.turns.entries()) {
    const turnId = `t${i + 1}`;
    const ctx = { ...(turn.driving ? { gear: "D", speedKmh: 60, naviGuiding: false } : { gear: "P", speedKmh: 0 }), ...(sc.ctx ?? {}), ...(turn.ctx ?? {}) };
    const t0 = performance.now();
    send({ type: "turn.start", turnId, trigger: "ptt" });
    send({ type: "ctx", turnId, ctx });
    send({ type: "text", turnId, text: turn.text });
    send({ type: "turn.end", turnId });
    const end = Date.now() + 30_000;
    const fin = () => frames.find((f) => f.turnId === turnId && (f.type === "reply.end" || f.type === "error"));
    while (!fin() && Date.now() < end) await Bun.sleep(20);
    const ms = Math.round(performance.now() - t0);
    const f = fin();
    const reply = !f ? "[NO REPLY]" : f.type === "error" ? `[ERROR ${f.code}]` : (f.text ?? "");
    if (sc.live && sc.turns[i + 1]?.waitMemoryMs) {
      const until = Date.now() + sc.turns[i + 1]!.waitMemoryMs!;
      const cnt = () => (side.query("SELECT count(*) c FROM memory WHERE install_id=?1").get(installId) as { c: number }).c;
      const before = cnt();
      while (cnt() === before && Date.now() < until) await Bun.sleep(200);
    }
    const j = reply.startsWith("[") ? null : await judge(sc, turn, reply, sc.turns.slice(0, i).map((x, k) => `[앞서 운전자가 한 말 ${k + 1}] ${x.text}\n`).join(""));
    const problems = scoreTalk(sc, turn, reply, j);
    rows.push({ sc: sc.id, cat: sc.cat, i, text: turn.text, reply, ms, problems, pass: problems.length === 0 });
  }
  ws.close();
  return rows;
}

const results: TurnRow[] = [];
let n = 0;
for (let r = 0; r < runs; r++) {
  for (const sc of scenarios) {
    const rows = await runScenario(sc, ++n);
    for (const v of rows) {
      results.push(v);
      console.log(`${v.pass ? "PASS" : "FAIL"} ${v.sc}#${v.i} ${v.text.slice(0, 24)} → ${v.reply.slice(0, 70)}${v.pass ? "" : `  !! ${v.problems.join("; ")}`}`);
    }
  }
}
await Bun.write(outPath, JSON.stringify(results, null, 1));
const bySc = new Map<string, boolean>();
for (const v of results) bySc.set(`${v.sc}`, (bySc.get(`${v.sc}`) ?? true) && v.pass);
const passTurns = results.filter((r) => r.pass).length;
console.log(`\nturn pass ${passTurns}/${results.length} = ${((100 * passTurns) / results.length).toFixed(1)}%`);
const sp = [...bySc.values()].filter(Boolean).length;
console.log(`scenario pass ${sp}/${bySc.size} = ${((100 * sp) / bySc.size).toFixed(1)}%  avg ${Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length)} ms`);
await server.stop(true);
side.close();
await Bun.file(dbPath).delete().catch(() => {});
process.exit(0);
