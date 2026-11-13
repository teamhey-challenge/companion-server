import { Observability } from "./observe";
import { installProcessGuards, makeLogWriter } from "./process-guard";

/** 서버 뼈대: 상태 확인 엔드포인트만 둔다. LLM 연동은 별도 작업에서 붙인다. */
const port = Number(process.env.PORT ?? 8787);
const observer = new Observability(makeLogWriter(process.env.COMPANION_LOG_FILE || undefined));

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, errors: observer.errors() });
    return new Response("not found", { status: 404 });
  },
});
observer.event("server.start", { port: server.port ?? port, pid: process.pid });

installProcessGuards({
  onError: (code, detail) => observer.error(code, detail),
  onFatal: () => void server.stop(),
});
