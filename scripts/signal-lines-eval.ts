/**
 * 차 신호 먼저 말 걸기(와이퍼·문·거리·라이트) + 기억 평가. 진짜 서버 경로(/v1/talk, 설정된 LLM, 텍스트만, TTS 없음)로
 * 기억을 심고 ctx 변화를 보내 먼저 나온 한마디를 결정적 규칙(길이·어투·이모지·훈계·사랑표현·영어·차 정보)으로 채점한다.
 *   bun scripts/signal-lines-eval.ts [--runs 3] [--out /tmp/signal-lines.json]
 * 기대: match=true 인 시나리오는 기억 단서(kw)를 말하거나(적중) 고정 문장(대체), match=false 는 고정 문장이어야 하고 LLM 호출이 없어야 한다.
 * 로컬 인스턴스만 띄운다. 키는 ~/.config/companion/server.env 에서만 읽고 출력하지 않는다.
 */
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observability } from "../src/observe";
import { createServer } from "../src/server";
import { loadTalkConfig } from "../src/talk";
import { L } from "../src/lines";
import { EMOJI, LECTURE, LOVE, MARKDOWN, SPEECH_BAN, carFactProblem, registerProblem, sentenceCount } from "./eval-rules";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const runs = Number(arg("--runs") ?? 3);
const outPath = arg("--out") ?? "/tmp/signal-lines.json";

interface Sc {
  id: string;
  speech: "banmal" | "jondaetmal";
  memory: string;
  signal: "wiper" | "door" | "range";
  /** 기억이 이 신호와 이어져야 하는가(태그·모델 판단). false 면 고정 문장이어야 한다. */
  match: boolean;
  /** 기억을 말했다고 볼 단서 */
  kw: RegExp;
}
const SCENARIOS: Sc[] = [
  { id: "rain-music", speech: "banmal", memory: "비 오는 날 잔잔한 노래를 듣는다", signal: "wiper", match: true, kw: /노래|음악|잔잔/ },
  { id: "rain-music-jd", speech: "jondaetmal", memory: "비 오는 날 재즈를 즐겨 듣는다", signal: "wiper", match: true, kw: /재즈|노래|음악/ },
  { id: "rain-umbrella", speech: "banmal", memory: "우산을 자주 잃어버린다", signal: "wiper", match: true, kw: /우산/ },
  { id: "rain-unrelated", speech: "banmal", memory: "딸 이름은 지우다", signal: "wiper", match: false, kw: /지우/ },
  { id: "rain-food", speech: "banmal", memory: "매운 음식을 좋아한다", signal: "wiper", match: false, kw: /매운/ },
  { id: "door-family", speech: "banmal", memory: "이번 주말에 가족이랑 같이 여행 간다", signal: "door", match: true, kw: /가족|여행|주말/ },
  { id: "door-unrelated", speech: "banmal", memory: "아메리카노를 좋아한다", signal: "door", match: false, kw: /아메리카노/ },
  { id: "range-trip", speech: "banmal", memory: "내일 부산으로 출장 간다", signal: "range", match: true, kw: /부산|출장/ },
  { id: "range-trip-jd", speech: "jondaetmal", memory: "이번 주말에 강릉으로 여행 간다", signal: "range", match: true, kw: /강릉|여행|주말/ },
  { id: "range-unrelated", speech: "banmal", memory: "강아지를 키운다", signal: "range", match: false, kw: /강아지/ },
];

const talk = loadTalkConfig();
if (!talk.apiKey) throw new Error("no LLM key");
const SECRET = "eval-provision";
const dbPath = join(tmpdir(), `signal-lines-${process.pid}.sqlite`);
let llmCalls = 0;
const countingFetch = ((u: string | URL | Request, init?: RequestInit) => {
  llmCalls++;
  return fetch(u, init);
}) as typeof fetch;
const server = createServer({
  port: 0, hostname: "127.0.0.1", talk, observer: new Observability(() => {}), dbPath, fetchImpl: countingFetch,
  guard: { provisionSecret: SECRET, trustProxy: false, turnsPerMin: 10_000, turnsPerDay: 100_000, upgradesPerMin: 10_000, httpPerMin: 10_000 },
  tts: null,
});
const base = `http://127.0.0.1:${server.port}`;
const side = new Database(dbPath);

const fixedLine = (sc: Sc): string => {
  const p = sc.signal === "wiper" ? L.wiper : sc.signal === "door" ? L.door : L.rangeEv;
  return p[sc.speech];
};

interface Row { sc: string; run: number; reply: string; ms: number; kind: "memory" | "fixed" | "other" | "none"; llm: number; problems: string[]; pass: boolean }

async function runOne(sc: Sc, n: number, run: number): Promise<Row> {
  const installId = `sl-install-${String(n).padStart(4, "0")}`;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const { carToken } = (await (await call("POST", "/v1/cars/register", { "x-provision-secret": SECRET }, { installId })).json()) as { carToken: string };
  const auth = { authorization: `Bearer ${carToken}` };
  for (const type of ["record", "external_ai", "memory"]) await call("POST", "/v1/consents", auth, { type, version: "1", granted: true, channel: "car" });
  await call("PATCH", "/v1/settings", auth, { speech: sc.speech, proactive: "normal" });
  side.query("INSERT INTO memory (id, install_id, kind, text, created_at) VALUES (?1, ?2, 'fact', ?3, ?4)").run(crypto.randomUUID(), installId, sc.memory, Date.now() - 3_600_000);
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
  const ctxs =
    sc.signal === "wiper" ? [{ gear: "D", speedKmh: 40, naviGuiding: false, wiper: "off" }, { gear: "D", speedKmh: 40, naviGuiding: false, wiper: "low" }]
    : sc.signal === "door" ? [{ gear: "N", speedKmh: 0 }, { gear: "P", speedKmh: 0, doorOpen: false }, { gear: "P", speedKmh: 0, doorOpen: true }]
    : [{ gear: "N", speedKmh: 0 }, { gear: "P", speedKmh: 0, rangeKm: 200, fuelType: 10 }, { gear: "P", speedKmh: 0, rangeKm: 30, fuelType: 10 }];
  const callsBefore = llmCalls;
  const t0 = performance.now();
  for (const c of ctxs) send({ type: "ctx", ctx: c });
  const end = Date.now() + 15_000;
  const fin = () => frames.find((f) => f.type === "reply.end" || f.type === "error");
  while (!fin() && Date.now() < end) await Bun.sleep(20);
  const ms = Math.round(performance.now() - t0);
  const f = fin();
  ws.close();
  const reply = f?.type === "reply.end" ? (f.text ?? "") : "";
  const llm = llmCalls - callsBefore;
  const problems: string[] = [];
  let kind: Row["kind"] = "none";
  if (!reply) problems.push(f ? `error ${f.code}` : "no reply");
  else {
    kind = reply === fixedLine(sc) ? "fixed" : sc.kw.test(reply) ? "memory" : "other";
    const ctx = ctxs.at(-1)!;
    if (sentenceCount(reply) > 2) problems.push("2문장 초과");
    const reg = registerProblem(reply, sc.speech);
    if (reg) problems.push(reg);
    if (EMOJI.test(reply) || MARKDOWN.test(reply) || SPEECH_BAN.test(reply)) problems.push("이모지·마크다운·자음웃음");
    if (LECTURE.test(reply) || /천천히|조심/.test(reply)) problems.push("운전 훈계");
    if (LOVE.test(reply)) problems.push("애정 표현");
    if (/[A-Za-z]{4,}/.test(reply)) problems.push("영어");
    const cf = carFactProblem(reply, ctx);
    if (cf) problems.push(cf);
    if (!sc.match && kind !== "fixed") problems.push("관련 없는 기억인데 고정 문장이 아님");
    if (!sc.match && llm > 0) problems.push(`관련 없는 기억인데 LLM ${llm}회 호출`);
    if (sc.match && kind === "other") problems.push("기억 단서도 고정 문장도 아님");
  }
  return { sc: sc.id, run, reply, ms, kind, llm, problems, pass: problems.length === 0 };
}

const rows: Row[] = [];
let n = 0;
for (let r = 0; r < runs; r++) {
  for (const sc of SCENARIOS) {
    const row = await runOne(sc, ++n, r);
    rows.push(row);
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.sc}#${r} [${row.kind}] ${row.ms}ms llm=${row.llm} → ${row.reply.slice(0, 60)}${row.pass ? "" : `  !! ${row.problems.join("; ")}`}`);
  }
}
await Bun.write(outPath, JSON.stringify(rows, null, 1));
const m = rows.filter((r) => SCENARIOS.find((s) => s.id === r.sc)!.match);
const nm = rows.filter((r) => !SCENARIOS.find((s) => s.id === r.sc)!.match);
const pct = (a: number, b: number) => (b ? `${a}/${b} = ${((100 * a) / b).toFixed(0)}%` : "0/0");
const avg = (a: Row[]) => (a.length ? Math.round(a.reduce((s, r) => s + r.ms, 0) / a.length) : 0);
const max = (a: Row[]) => a.reduce((s, r) => Math.max(s, r.ms), 0);
console.log(`\npass ${pct(rows.filter((r) => r.pass).length, rows.length)}`);
console.log(`related-memory scenarios: memory line ${pct(m.filter((r) => r.kind === "memory").length, m.length)}, fixed fallback ${pct(m.filter((r) => r.kind === "fixed").length, m.length)}, avg ${avg(m)} ms, max ${max(m)} ms`);
console.log(`unrelated-memory scenarios: fixed line ${pct(nm.filter((r) => r.kind === "fixed").length, nm.length)}, LLM calls ${nm.reduce((s, r) => s + r.llm, 0)}, avg ${avg(nm)} ms`);
await server.stop(true);
side.close();
await Bun.file(dbPath).delete().catch(() => {});
process.exit(0);
