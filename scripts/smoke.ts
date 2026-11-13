// 사용: bun run scripts/smoke.ts ["문장"]  → 서버를 띄워 한 턴을 보내고 시간·모델을 출력한다. (provider는 LLM_PROVIDER, 기본 openai-compatible)
export {};
const text = process.argv[2] ?? "오늘 비 와서 천천히 갈게";
const port = Number(process.env.SMOKE_PORT ?? 18800);
const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
  env: { ...process.env, PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});
await Bun.sleep(700);
const result = await new Promise<string>((resolve) => {
  const ws = new WebSocket(`ws://localhost:${port}/v1/talk`);
  let reply = "";
  let model = "";
  const timer = setTimeout(() => resolve("timeout"), 30000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "turn", text, ctx: { speedKph: 0 } }));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "reply.start") model = m.model;
    if (m.type === "reply.delta") reply += m.text;
    if (m.type === "reply.end") {
      clearTimeout(timer);
      resolve(`ok model=${model} resolvedModel=${m.resolvedModel} firstTokenMs=${m.firstTokenMs} totalMs=${m.totalMs} chars=${m.chars}\nreply="${reply}"`);
    }
    if (m.type === "error") { clearTimeout(timer); resolve(`error ${m.code} ${m.message ?? ""}`); }
  };
  ws.onerror = () => resolve("ws error");
});
console.log(result);
proc.kill();
