import { checkToken, clientIp, isLocalRequest, type GuardConfig } from "./auth";
import { SystemClock, type Clock } from "./clock";
import type { Observability } from "./observe";
import { RateLimiter } from "./rate-limit";
import { talkHandlers, type TalkConfig, type WsData } from "./talk";

export type RunningServer = Bun.Server<WsData>;

export interface ServerOptions {
  port: number;
  hostname?: string;
  talk: TalkConfig;
  guard: GuardConfig;
  observer: Observability;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

/** /healthz + /v1/talk. 토큰 없는 업그레이드는 401, IP별 시도 한도 초과는 429로 업그레이드 전에 끊는다. */
export function createServer(o: ServerOptions): RunningServer {
  const clock = o.clock ?? new SystemClock();
  const limiter = new RateLimiter(clock);
  return Bun.serve<WsData>({
    port: o.port,
    hostname: o.hostname,
    fetch(req, srv) {
      const url = new URL(req.url);
      const socketIp = srv.requestIP(req)?.address;
      if (url.pathname === "/healthz") {
        if (!isLocalRequest(req.headers, socketIp)) return Response.json({ ok: true });
        return Response.json({ ok: true, provider: o.talk.providerName, model: o.talk.model, errors: o.observer.errors() });
      }
      if (url.pathname !== "/v1/talk") return new Response("not found", { status: 404 });
      const ip = clientIp(req.headers, socketIp, o.guard.trustProxy);
      try {
        limiter.hit(`up:${ip}`, o.guard.upgradesPerMin, 60_000);
      } catch {
        o.observer.reject("talk.upgrade_rate_limited");
        return new Response("rate limited", { status: 429 });
      }
      const auth = checkToken(req.headers, o.guard.token);
      if (!auth.ok) {
        o.observer.reject("talk.unauthorized");
        return new Response("unauthorized", { status: 401 });
      }
      const headers = auth.protocol ? { "Sec-WebSocket-Protocol": auth.protocol } : undefined;
      if (srv.upgrade(req, { data: { id: crypto.randomUUID() }, headers })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: { ...talkHandlers(o.talk, o.observer, { guard: o.guard, limiter, fetchImpl: o.fetchImpl }), maxPayloadLength: 4 * 1024 },
  });
}
