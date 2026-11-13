import { loadGuardConfig } from "./auth";
import { Observability } from "./observe";
import { installProcessGuards, makeLogWriter } from "./process-guard";
import { createServer } from "./server";
import { loadTalkConfig } from "./talk";

/** 서버 진입점: /healthz + /v1/talk(텍스트 전용 웹소켓, 오디오·위치 수신 안 함). */
const port = Number(process.env.PORT ?? 8787);
const observer = new Observability(makeLogWriter(process.env.COMPANION_LOG_FILE || undefined));
const cfg = loadTalkConfig();
if (!cfg.apiKey) observer.error("config.no_key", cfg.providerName);
const guard = loadGuardConfig();
if (guard.token === undefined) observer.error("config.no_auth", "COMPANION_ALLOW_NO_AUTH=1");

const server = createServer({ port, hostname: process.env.HOST || undefined, talk: cfg, guard, observer });
observer.event("server.start", { port: server.port ?? port, pid: process.pid, provider: cfg.providerName, model: cfg.model });

installProcessGuards({
  onError: (code, detail) => observer.error(code, detail),
  onFatal: () => void server.stop(),
});
