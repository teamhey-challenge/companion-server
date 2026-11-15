import type { PairingStatus, RegisterResponse, SessionResponse, Settings } from "../shared/packages/protocol/src/index";
import { Social, type DiaryLlm } from "./social";
import { getProvider, streamLlm } from "./llm/providers";
import { handleApi } from "./api";
import { ApiStore } from "./api-store";
import { bearer, clientIp, isLocalRequest, safeEqual, type GuardConfig } from "./auth";
import { SystemClock, type Clock } from "./clock";
import type { Observability } from "./observe";
import { RateLimiter } from "./rate-limit";
import { CarStore, TicketBook } from "./store";
import { GoogleVerifier } from "./google";
import { TalkHub, talkHandlers, type TalkConfig, type WsData } from "./talk";
import type { TtsProvider } from "./tts";

export type RunningServer = Bun.Server<WsData>;

export interface ServerOptions {
  port: number;
  hostname?: string;
  talk: TalkConfig;
  guard: GuardConfig;
  observer: Observability;
  /** 차량 등록 DB 파일 경로(":memory:" 가능). */
  dbPath: string;
  fetchImpl?: typeof fetch;
  /** 서버 TTS. 없으면 reply.start.audio = "none". */
  tts?: TtsProvider | null;
  clock?: Clock;
  /** ServerTalk 허브: 설정이 바뀌면 그 차의 열린 소켓에 settings 프레임을 보낸다. */
  hub?: { pushSettings(installId: string, settings: Settings): void; pushPairing?(installId: string, status: PairingStatus): void };
  /** 토큰 없는 공개 경로(코드 조회·claim)의 IP별 분당 한도. */
  publicPerMin?: number;
  /** 도착 인사까지의 시간(F10, 기본 3초). 시험에서만 바꾼다. */
  arrivalDelayMs?: number;
  fillerAfterMs?: number;
  llmDeadlineMs?: number;
  /** 기억 담은 먼저 말(도착·첫 인사)이 첫 글자를 이 시간 안에 못 받으면 고정 문장으로 말한다(기본 3.5초). 시험에서만 바꾼다. */
  proactiveLlmFirstMs?: number;
  /** 온보딩 고래 맞장구가 첫 글자를 이 시간 안에 못 받으면 고정 문장(기본 2.5초). 시험에서만 바꾼다. */
  onboardingAckFirstMs?: number;
  /** 초대 링크 앞부분(PASSENGER_WEB_URL). 끝 슬래시는 뗀다. */
  passengerWebUrl?: string;
  /** 기어 P 를 두면 운전이 끝난 것으로 보는 시간(기본 60초). 시험에서만 바꾼다. */
  tripHoldMs?: number;
  /** 구글 로그인 웹 클라이언트 ID(GOOGLE_WEB_CLIENT_ID). 없으면 /v1/auth/google 은 503. */
  googleClientId?: string;
  /** 구글 공개키(JWKS) 요청용 fetch. 시험에서만 바꾼다. */
  googleFetch?: typeof fetch;
  /** e2e 전용(COMPANION_ALLOW_NONGOOGLE_CLAIM=1): 구글이 아닌 폰 토큰의 연결도 받는다. 운영은 끈다(D-57). */
  allowNonGoogleClaim?: boolean;
  /** 시험 전용(COMPANION_ALLOW_PHONE_ONLY=1): 폰 전용 계정을 허용한다. 운영은 끈다(D-58). */
  allowPhoneOnly?: boolean;
}

const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * /healthz, POST /v1/cars/register, POST /v1/sessions, WS /v1/talk?ticket=.
 * 등록은 프로비전 비밀(X-Provision-Secret), 세션은 carToken(Bearer), 웹소켓은 한 번 쓰는 짧은 티켓으로만 연다.
 */
export function createServer(o: ServerOptions): RunningServer {
  const clock = o.clock ?? new SystemClock();
  const limiter = new RateLimiter(clock);
  const cars = new CarStore(o.dbPath, clock);
  const api = new ApiStore(cars.db, clock);
  const tickets = new TicketBook(clock);
  const google = o.googleClientId ? new GoogleVerifier(o.googleClientId, clock, o.googleFetch) : null;
  const talkHub = new TalkHub();
  const provider = getProvider(o.talk.providerName);
  /** 일기 글쓰기: 말하는 것과 같은 모델·키. 키가 없으면 일기 요약은 만들지 않는다. */
  const diaryLlm: DiaryLlm | null = o.talk.apiKey
    ? async (system, user) => {
        let out = "";
        const req = { model: o.talk.model, system, userText: user, maxTokens: 300, baseUrl: o.talk.baseUrl };
        for await (const d of streamLlm(provider, req, o.talk.apiKey!, o.fetchImpl ?? fetch, undefined, AbortSignal.timeout(30_000))) out += d;
        return out;
      }
    : null;
  const social = new Social(api, cars.db, clock, talkHub, o.observer, diaryLlm);

  const throttled = (ip: string, bucket: string, max: number) => {
    try {
      limiter.hit(`${bucket}:${ip}`, max, 60_000);
      return false;
    } catch {
      o.observer.reject(`${bucket}.rate_limited`);
      return true;
    }
  };

  async function register(req: Request): Promise<Response> {
    const given = req.headers.get("x-provision-secret") ?? "";
    if (o.guard.provisionSecret !== undefined && !safeEqual(given, o.guard.provisionSecret)) {
      o.observer.reject("register.forbidden");
      return json({ error: "forbidden" }, 403);
    }
    const body = (await req.json().catch(() => null)) as { installId?: unknown } | null;
    const id = body?.installId;
    if (typeof id !== "string" || !INSTALL_ID.test(id)) return json({ error: "bad_request" }, 400);
    const res: RegisterResponse = { carToken: cars.register(id) };
    o.observer.event("car.registered", {});
    return json(res);
  }

  function session(req: Request): Response {
    const token = bearer(req.headers);
    const installId = token ? cars.lookup(token) : null;
    if (!installId) {
      o.observer.reject("session.unauthorized");
      return json({ error: "unauthorized" }, 401);
    }
    const t = tickets.issue(installId);
    const res: SessionResponse = { sessionId: t.sessionId, wsTicket: t.wsTicket, expiresInSec: t.expiresInSec };
    return json(res);
  }

  const talk = talkHandlers(o.talk, o.observer, { guard: o.guard, limiter, fetchImpl: o.fetchImpl, tts: o.tts, store: api, hub: talkHub, clock, arrivalDelayMs: o.arrivalDelayMs, fillerAfterMs: o.fillerAfterMs, llmDeadlineMs: o.llmDeadlineMs, proactiveLlmFirstMs: o.proactiveLlmFirstMs, ...(o.onboardingAckFirstMs !== undefined ? { onboardingAckFirstMs: o.onboardingAckFirstMs } : {}), social, tripHoldMs: o.tripHoldMs });

  const server = Bun.serve<WsData>({
    port: o.port,
    hostname: o.hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const socketIp = srv.requestIP(req)?.address;
      if (url.pathname === "/healthz") {
        if (!isLocalRequest(req.headers, socketIp)) return json({ ok: true });
        return json({ ok: true, provider: o.talk.providerName, model: o.talk.model, errors: o.observer.errors(), latency: o.observer.latency() });
      }
      const ip = clientIp(req.headers, socketIp, o.guard.trustProxy);
      if (url.pathname === "/v1/cars/register" && req.method === "POST") {
        if (throttled(ip, "reg", o.guard.httpPerMin)) return json({ error: "rate_limited" }, 429);
        return register(req);
      }
      if (url.pathname === "/v1/sessions" && req.method === "POST") {
        if (throttled(ip, "ses", o.guard.httpPerMin)) return json({ error: "rate_limited" }, 429);
        return session(req);
      }
      const apiRes = await handleApi(req, url, ip, {
        api,
        cars,
        social,
        tickets,
        passengerWebUrl: (o.passengerWebUrl ?? "https://hey.lastmile.ltd").replace(/\/+$/, ""),
        pushSettings: (id, s) => {
          talkHub.pushSettings(id, s);
          o.hub?.pushSettings(id, s);
        },
        pushPairing: (id, st) => {
          talkHub.pushPairing(id, st);
          o.hub?.pushPairing?.(id, st);
        },
        pushLinked: (id, name) => talkHub.pushLinked(id, name),
        allowNonGoogleClaim: o.allowNonGoogleClaim ?? false,
        allowPhoneOnly: o.allowPhoneOnly ?? false,
        consentChanged: (id, withdrawn) => talkHub.consentChanged(id, withdrawn),
        throttled,
        publicPerMin: o.publicPerMin ?? 20,
        reject: (r) => o.observer.reject(r),
        google,
      });
      if (apiRes) return apiRes;
      const isInbox = url.pathname === "/v1/inbox/stream";
      if (url.pathname !== "/v1/talk" && !isInbox) return new Response("not found", { status: 404 });
      if (throttled(ip, "up", o.guard.upgradesPerMin)) return new Response("rate limited", { status: 429 });
      const ticket = url.searchParams.get("ticket");
      const t = ticket ? tickets.consume(ticket) : null;
      if (!t || (isInbox && t.kind !== "phone")) {
        o.observer.reject(isInbox ? "inbox.unauthorized" : "talk.unauthorized");
        return new Response("unauthorized", { status: 401 });
      }
      const data: WsData = { id: crypto.randomUUID(), installId: t.installId, sessionId: t.sessionId, hello: false, kind: t.kind, inbox: isInbox };
      if (srv.upgrade(req, { data })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open: (ws) => (ws.data.inbox ? social.inbox.add(ws) : talk.open(ws)),
      close: (ws) => (ws.data.inbox ? social.inbox.remove(ws) : talk.close(ws)),
      // 받은편지함 소켓은 서버가 보내기만 한다. 폰이 보낸 말은 무시한다.
      message: (ws, data) => (ws.data.inbox ? undefined : talk.message(ws, data)),
      maxPayloadLength: 4 * 1024,
    },
  });
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    const r = stop(force);
    cars.close();
    return r;
  };
  return server;
}
