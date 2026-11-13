// 사용: bun run scripts/smoke.ts ["문장"] [횟수]
//   SMOKE_BASE=https://hey.lastmile.ltd/api 이면 공개 서버에, 없으면 서버를 새로 띄워 시험한다.
//   등록 비밀은 환경변수 COMPANION_PROVISION_SECRET 또는 ~/.config/companion/server.env 에서 읽는다(값은 출력하지 않는다).
// 한 턴마다 turn.end → 첫 reply.delta, 첫 오디오 바이트, reply.end 까지의 ms 와 오디오 바이트 수를 출력한다.
import { PROVISION_HEADER, type RegisterResponse, type SessionResponse } from "../shared/packages/protocol/src/index";
import { loadSecrets } from "../src/llm/secrets";

const text = process.argv[2] ?? "오늘 비 와서 천천히 갈게";
const turns = Number(process.argv[3] ?? 1);
const provision = process.env.COMPANION_PROVISION_SECRET ?? loadSecrets().COMPANION_PROVISION_SECRET ?? "";

let proc: Bun.Subprocess | undefined;
let base = process.env.SMOKE_BASE;
if (!base) {
  const port = Number(process.env.SMOKE_PORT ?? 18800);
  proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", COMPANION_DATA_DIR: process.env.COMPANION_DATA_DIR ?? "/tmp/companion-smoke" },
    stdout: "ignore",
    stderr: "inherit",
  });
  await Bun.sleep(700);
  base = `http://127.0.0.1:${port}`;
}

const installId = process.env.SMOKE_INSTALL_ID ?? `smoke-${crypto.randomUUID().slice(0, 12)}`;
const reg = await fetch(`${base}/v1/cars/register`, { method: "POST", headers: { [PROVISION_HEADER]: provision, "content-type": "application/json" }, body: JSON.stringify({ installId }) });
if (!reg.ok) throw new Error(`register ${reg.status}`);
const { carToken } = (await reg.json()) as RegisterResponse;

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
  console.log(typeof r === "string" ? r : `turn ${i}: audio=${r.audio} firstDeltaMs=${r.firstDeltaMs} firstAudioMs=${r.firstAudioMs} totalMs=${r.totalMs} audioBytes=${r.audioBytes} chars=${r.reply.length}`);
}
proc?.kill();
