import { loadGuardConfig } from "./auth";
import { Observability } from "./observe";
import { installProcessGuards, makeLogWriter } from "./process-guard";
import { createServer } from "./server";
import { fixedPieces } from "./lines";
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

// 고정 문장은 한 번 합성해 메모리에만 둔다(D-10). 백그라운드로, 공급사 자리 하나씩. COMPANION_TTS_PRIME=0 이면 건너뛴다.
if (tts && process.env.COMPANION_TTS_PRIME !== "0") {
  const pieces = fixedPieces();
  void tts.prime(pieces).then((r) => observer.event("tts.primed", { pieces: pieces.length, done: r.done, failed: r.failed, entries: r.entries, bytes: r.bytes }));
}

installProcessGuards({
  onError: (code, detail) => observer.error(code, detail),
  onFatal: () => void server.stop(),
});
