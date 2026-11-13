import { loadGuardConfig } from "./auth";
import { Observability } from "./observe";
import { installProcessGuards, makeLogWriter } from "./process-guard";
import { createServer } from "./server";
import { loadTalkConfig } from "./talk";
import { loadTtsConfig, makeTts } from "./tts";

/** 서버 진입점: /healthz, 차량 등록·세션 발급, /v1/talk(티켓 웹소켓, 오디오·위치 수신 안 함). */
const port = Number(process.env.PORT ?? 8787);
const observer = new Observability(makeLogWriter(process.env.COMPANION_LOG_FILE || undefined));
const cfg = loadTalkConfig();
if (!cfg.apiKey) observer.error("config.no_key", cfg.providerName);
const guard = loadGuardConfig();
if (guard.provisionSecret === undefined) observer.error("config.no_auth", "COMPANION_ALLOW_NO_AUTH=1");
const dbPath = `${process.env.COMPANION_DATA_DIR || "./data"}/companion.sqlite`;
const ttsCfg = loadTtsConfig();
const tts = makeTts(ttsCfg, observer);
const server = createServer({ port, hostname: process.env.HOST || undefined, talk: cfg, guard, observer, dbPath, tts });
observer.event("server.start", { port: server.port ?? port, pid: process.pid, provider: cfg.providerName, model: cfg.model, tts: ttsCfg.provider });

installProcessGuards({
  onError: (code, detail) => observer.error(code, detail),
  onFatal: () => void server.stop(),
});
