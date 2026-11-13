import { Observability } from "./observe";
import { installProcessGuards, makeLogWriter } from "./process-guard";
import { loadTalkConfig, talkHandlers } from "./talk";

/** 서버 진입점: /healthz + /v1/talk(텍스트 전용 웹소켓, 오디오·위치 수신 안 함). */
const port = Number(process.env.PORT ?? 8787);
const observer = new Observability(makeLogWriter(process.env.COMPANION_LOG_FILE || undefined));
const cfg = loadTalkConfig();
if (!cfg.apiKey) observer.error("config.no_key", cfg.providerName);

const server = Bun.serve({
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, provider: cfg.providerName, model: cfg.model, errors: observer.errors() });
    }
    if (url.pathname === "/v1/talk" && srv.upgrade(req)) return;
    return new Response("not found", { status: 404 });
  },
  websocket: { ...talkHandlers(cfg, observer), maxPayloadLength: 4 * 1024 },
});
observer.event("server.start", { port: server.port ?? port, pid: process.pid, provider: cfg.providerName, model: cfg.model });

installProcessGuards({
  onError: (code, detail) => observer.error(code, detail),
  onFatal: () => void server.stop(),
});
