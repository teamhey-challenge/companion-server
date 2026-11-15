// 사용: bun run scripts/smoke.ts ["문장"] [횟수]
//   SMOKE_BASE=https://hey.lastmile.ltd/api 이면 공개 서버에, 없으면 서버를 새로 띄워 시험한다.
// 한 턴마다 turn.end → 첫 reply.delta, 첫 오디오 바이트, reply.end 까지의 ms 와 오디오 바이트 수를 출력한다.
import { type RegisterResponse, type SessionResponse } from "../shared/packages/protocol/src/index";
import { SentenceSplitter } from "../src/tts";

const text = process.argv[2] ?? "오늘 비 와서 천천히 갈게";
const turns = Number(process.argv[3] ?? 1);

let proc: Bun.Subprocess | undefined;
const base: string = process.env.SMOKE_BASE ?? (await startLocal());

async function startLocal(): Promise<string> {
  const port = Number(process.env.SMOKE_PORT ?? 18800);
  proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", COMPANION_DATA_DIR: process.env.COMPANION_DATA_DIR ?? "/tmp/companion-smoke" },
    stdout: "ignore",
    stderr: "inherit",
  });
  await Bun.sleep(700);
  return `http://127.0.0.1:${port}`;
}

const installId = process.env.SMOKE_INSTALL_ID ?? `smoke-${crypto.randomUUID().slice(0, 12)}`;
const reg = await fetch(`${base}/v1/cars/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installId }) });
if (!reg.ok) throw new Error(`register ${reg.status}`);
const { carToken } = (await reg.json()) as RegisterResponse;
// 동의 없이는 답하지 않는다(consent_required): 시험 차에 필요한 동의를 준다. memory 는 주지 않아 기억 추출 호출이 안 생긴다.
for (const type of ["record", "external_ai"]) {
  await fetch(`${base}/v1/consents`, { method: "POST", headers: { authorization: `Bearer ${carToken}`, "content-type": "application/json" }, body: JSON.stringify({ type, version: "1", granted: true, channel: "car" }) });
}

interface Measure { firstDeltaMs: number | null; firstAudioMs: number | null; totalMs: number; audioBytes: number; audio: string; reply: string }

async function oneTurn(n: number): Promise<Measure | string> {
  const ses = await fetch(`${base}/v1/sessions`, { method: "POST", headers: { authorization: `Bearer ${carToken}` } });
  if (!ses.ok) return `session ${ses.status}`;
  const { wsTicket } = (await ses.json()) as SessionResponse;
  const { promise, resolve } = Promise.withResolvers<Measure | string>();
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/v1/talk?ticket=${wsTicket}`);
  ws.binaryType = "arraybuffer";
  const timer = setTimeout(() => resolve("timeout"), 60_000);
  let t0 = 0;
  const m: Measure = { firstDeltaMs: null, firstAudioMs: null, totalMs: 0, audioBytes: 0, audio: "?", reply: "" };
  const id = `t${n}`;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", v: 1, appVersion: "smoke" }));
    ws.send(JSON.stringify({ type: "turn.start", turnId: id, trigger: "ptt" }));
    ws.send(JSON.stringify({ type: "ctx", turnId: id, ctx: { gear: "D", speedBand: "slow" } }));
    ws.send(JSON.stringify({ type: "text", turnId: id, text }));
    t0 = performance.now();
    ws.send(JSON.stringify({ type: "turn.end", turnId: id }));
  };
  ws.onmessage = (e) => {
    const at = Math.round(performance.now() - t0);
    if (typeof e.data !== "string") {
      m.firstAudioMs ??= at;
      m.audioBytes += (e.data as ArrayBuffer).byteLength;
      return;
    }
    const f = JSON.parse(e.data) as { type: string; text?: string; code?: string; audio?: unknown };
    if (f.type === "reply.start") m.audio = typeof f.audio === "string" ? f.audio : "pcm";
    if (f.type === "reply.delta") {
      m.firstDeltaMs ??= at;
      m.reply += f.text ?? "";
    }
    if (f.type === "reply.end") {
      m.totalMs = at;
      clearTimeout(timer);
      resolve(m);
    }
    if (f.type === "error") {
      clearTimeout(timer);
      resolve(`error ${f.code}`);
    }
  };
  ws.onerror = () => resolve("ws error");
  const r = await promise;
  ws.close();
  return r;
}

for (let i = 0; i < turns; i++) {
  const r = await oneTurn(i);
  if (typeof r === "string") {
    console.log(r);
    continue;
  }
  const sp = new SentenceSplitter();
  const calls = sp.push(r.reply).length + sp.flush().length; // 문장 하나 = BreezeBlue 호출 하나
  console.log(`turn ${i}: audio=${r.audio} firstDeltaMs=${r.firstDeltaMs} firstAudioMs=${r.firstAudioMs} totalMs=${r.totalMs} audioBytes=${r.audioBytes} chars=${r.reply.length} ttsCalls=${calls}`);
}
proc?.kill();
