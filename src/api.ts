import {
  CONSENT_TYPES,
  MAX_NICKNAME_CHARS,
  PAIR_CODE_RE,
  PHONE_SETTINGS_KEYS,
  PROACTIVE_LEVELS,
  SPEECH_STYLES,
  sanitizeCtx,
  type ConsentChannel,
  type ConsentType,
  type PairingStatus,
} from "../shared/packages/protocol/src/index";
import type { ApiStore, Principal, ServerSettings, ServerSettingsPatch } from "./api-store";
import { CHECKIN_TIME_RE, LOOK_MAX, MAX_DISPLAY_NAME_CHARS, characterFor } from "./api-store";
import { bearer } from "./auth";
import type { Social } from "./social";
import { INVITE_CODE_RE, MAX_MESSAGE_CHARS } from "./social-store";
import type { CarStore, TicketBook } from "./store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const noContent = () => new Response(null, { status: 204 });
const bad = (error = "bad_request") => json({ error }, 400);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VEHICLE_EVENTS = 50;
const MAX_MEMORY_PAGE = 100;
const DEFAULT_MEMORY_PAGE = 50;
const SETTINGS_KEYS = ["proactive", "memoryEnabled", "speech", "nickname", "bodyColor", "hat", "neck", "displayName", "checkinTime"] as const;
/** 폰 토큰이 바꿀 수 있는 설정(공유 규칙의 speech 에 더해). */
const PHONE_KEYS: readonly string[] = [...PHONE_SETTINGS_KEYS, "displayName", "checkinTime"];

export interface ApiDeps {
  api: ApiStore;
  cars: CarStore;
  social: Social;
  tickets: TicketBook;
  /** 폰 가입·초대 링크 주소의 앞부분(끝 슬래시 없음). */
  passengerWebUrl: string;
  /** 설정이 바뀌면 그 차의 열린 소켓에 settings 프레임을 보낸다. */
  pushSettings?: (installId: string, settings: ServerSettings) => void;
  /** 폰·차가 연결을 해제하면 그 차의 열린 소켓에 pairing(none) 프레임을 보낸다. */
  pushPairing?: (installId: string, status: PairingStatus) => void;
  /** 동의가 바뀌면 그 차의 열린 소켓이 미뤄 둔 첫 정차 인사·첫 만남을 이어 간다. */
  consentChanged?: (installId: string, withdrawn: boolean) => void;
  /** 공개 엔드포인트(코드 조회·claim) 열거 방지용 IP별 제한. true면 거절. */
  throttled: (ip: string, bucket: string, max: number) => boolean;
  publicPerMin: number;
  reject: (reason: string) => void;
}

/** 차 토큰이면 car, 폰 토큰이면 phone. 둘 다 그 토큰이 속한 차 하나만 가리킨다. */
function authenticate(req: Request, d: ApiDeps): Principal | null {
  const token = bearer(req.headers);
  if (!token) return null;
  const car = d.cars.lookup(token);
  if (car) return { kind: "car", installId: car };
  const phone = d.api.phoneLookup(token);
  return phone ? { kind: "phone", installId: phone } : null;
}

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return undefined;
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parsePatch(body: unknown): ServerSettingsPatch | null {
  if (!isObj(body)) return null;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(k)) return null;
    if (k === "proactive" && !(PROACTIVE_LEVELS as readonly unknown[]).includes(v)) return null;
    if (k === "speech" && !(SPEECH_STYLES as readonly unknown[]).includes(v)) return null;
    if (k === "memoryEnabled" && typeof v !== "boolean") return null;
    if (k === "bodyColor" || k === "hat" || k === "neck") {
      // bodyColor null = follow the theme again; hat/neck have no "unset", 0 is none.
      const ok = Number.isInteger(v) && (v as number) >= 0 && (v as number) <= LOOK_MAX[k];
      if (!ok && !(k === "bodyColor" && v === null)) return null;
      patch[k] = v;
      continue;
    }
    if (k === "nickname") {
      if (v !== null && typeof v !== "string") return null;
      const t = typeof v === "string" ? v.trim() : null;
      if (t !== null && [...t].length > MAX_NICKNAME_CHARS) return null;
      patch[k] = t ? t : null;
      continue;
    }
    if (k === "displayName") {
      const t = typeof v === "string" ? v.trim() : "";
      if (!t || [...t].length > MAX_DISPLAY_NAME_CHARS) return null;
      patch[k] = t;
      continue;
    }
    if (k === "checkinTime") {
      if (v !== null && !(typeof v === "string" && CHECKIN_TIME_RE.test(v))) return null;
      patch[k] = v;
      continue;
    }
    patch[k] = v;
  }
  return Object.keys(patch).length > 0 ? (patch as ServerSettingsPatch) : null;
}

/** /v1/consents, /v1/pairings, /v1/memory, /v1/settings, /v1/vehicle-events. 해당 없으면 null. */
export async function handleApi(req: Request, url: URL, ip: string, d: ApiDeps): Promise<Response | null> {
  const path = url.pathname;
  const m = req.method;

  // ---- 토큰 없는 공개 경로(폰 연결 전) ----
  if (path === "/v1/phones/register" && m === "POST") {
    if (d.throttled(ip, "phreg", d.publicPerMin)) return json({ error: "rate_limited" }, 429);
    const b = await readJson(req);
    const name = isObj(b) && typeof b.displayName === "string" ? b.displayName.trim() : "";
    if (!name || [...name].length > MAX_DISPLAY_NAME_CHARS) return bad();
    return json(d.api.registerPhoneAccount(name));
  }
  const pub = /^\/v1\/pairings\/([^/]+)(\/claim)?$/.exec(path);
  if (pub && pub[1] !== "current") {
    const code = pub[1]!;
    const isClaim = pub[2] !== undefined;
    if (isClaim ? m !== "POST" : m !== "GET") return null;
    if (d.throttled(ip, isClaim ? "claim" : "pairget", d.publicPerMin)) return json({ error: "rate_limited" }, 429);
    if (!isClaim) {
      const p = PAIR_CODE_RE.test(code) ? d.api.publicPairing(code) : { status: "unknown" as const, installId: null };
      return json({ status: p.status, character: characterFor(p.installId) });
    }
    const body = await readJson(req);
    if (!isObj(body) || typeof body.record !== "boolean" || typeof body.memory !== "boolean") return bad();
    if (!body.record) return bad("record_required");
    if (!PAIR_CODE_RE.test(code)) return json({ error: "unknown" }, 404);
    const r = d.api.claimPairing(code, body.record, body.memory);
    if (!r.ok) return json({ error: r.reason }, r.reason === "unknown" ? 404 : r.reason === "claimed" ? 409 : 410);
    return json({ phoneToken: r.phoneToken, character: r.character });
  }

  const known = /^\/v1\/(consents|pairings|memory|settings|vehicle-events|friends|messages|diary|phone-sessions)(\/|$)/.test(path);
  if (!known) return null;

  const who = authenticate(req, d);
  if (!who) {
    d.reject("api.unauthorized");
    return json({ error: "unauthorized" }, 401);
  }
  const { installId } = who;
  const carOnly = (): Response | null => (who.kind === "car" ? null : json({ error: "forbidden" }, 403));

  if (path === "/v1/phone-sessions" && m === "POST") {
    if (who.kind !== "phone") return json({ error: "forbidden" }, 403);
    if (d.throttled(ip, "phses", d.publicPerMin * 3)) return json({ error: "rate_limited" }, 429);
    const t = d.tickets.issue(installId, "any", "phone");
    return json({ sessionId: t.sessionId, wsTicket: t.wsTicket, expiresInSec: t.expiresInSec });
  }

  const socialRes = await handleSocial(req, url, path, m, installId, d);
  if (socialRes) return socialRes;

  if (path === "/v1/consents") {
    if (m === "GET") return json({ consents: d.api.listConsents(installId) });
    if (m !== "POST") return null;
    const b = await readJson(req);
    if (!isObj(b) || !(CONSENT_TYPES as readonly unknown[]).includes(b.type) || typeof b.granted !== "boolean") return bad();
    if (typeof b.version !== "string" || b.version.length < 1 || b.version.length > 32) return bad();
    if (b.channel !== "car" && b.channel !== "phone") return bad();
    // 채널은 토큰 종류와 일치해야 한다
    if ((b.channel as ConsentChannel) !== who.kind) return bad("channel_mismatch");
    d.api.setConsent(installId, b.type as ConsentType, b.version, b.granted);
    d.consentChanged?.(installId, !b.granted);
    return json({ consents: d.api.listConsents(installId) });
  }
  const consent = /^\/v1\/consents\/([^/]+)$/.exec(path);
  if (consent && m === "DELETE") {
    if (!(CONSENT_TYPES as readonly string[]).includes(consent[1]!)) return bad();
    d.api.withdrawConsent(installId, consent[1] as ConsentType);
    d.consentChanged?.(installId, true);
    return noContent();
  }

  if (path === "/v1/pairings" && m === "POST") return carOnly() ?? json(d.api.createPairing(installId));
  if (path === "/v1/pairings/current") {
    if (m === "GET") return carOnly() ?? json(d.api.currentPairing(installId));
    if (m === "DELETE") {
      // 차·폰 모두 가능. installId는 토큰에서 나온 값(폰은 phone_hash로 찾은 자기 차)이라 다른 차의 연결은 건드릴 수 없다.
      d.api.unpair(installId);
      d.pushPairing?.(installId, "none");
      return noContent();
    }
    return null;
  }

  if (path === "/v1/memory") {
    if (m === "GET") {
      const limit = Math.min(MAX_MEMORY_PAGE, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_MEMORY_PAGE) || DEFAULT_MEMORY_PAGE));
      const c = url.searchParams.get("cursor");
      const cursor = c === null || c === "" ? null : Number(c);
      if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) return bad();
      return json(d.api.pageMemory(installId, cursor, Math.floor(limit)));
    }
    if (m === "DELETE") {
      d.api.deleteAllMemory(installId);
      return noContent();
    }
    return null;
  }
  const mem = /^\/v1\/memory\/([^/]+)$/.exec(path);
  if (mem && m === "DELETE") {
    d.api.deleteMemory(installId, decodeURIComponent(mem[1]!));
    return noContent();
  }

  if (path === "/v1/settings") {
    if (m === "GET") return json(d.api.getSettings(installId));
    if (m !== "PATCH") return null;
    const patch = parsePatch(await readJson(req));
    if (!patch) return bad();
    if (who.kind === "phone" && Object.keys(patch).some((k) => !PHONE_KEYS.includes(k))) {
      return json({ error: "forbidden" }, 403);
    }
    const next = d.api.patchSettings(installId, patch);
    d.pushSettings?.(installId, next);
    return json(next);
  }

  if (path === "/v1/vehicle-events" && m === "POST") {
    const denied = carOnly();
    if (denied) return denied;
    const b = await readJson(req);
    if (!Array.isArray(b) || b.length > MAX_VEHICLE_EVENTS) return bad();
    const events: { at: string; ctx: Record<string, unknown> }[] = [];
    for (const e of b) {
      if (!isObj(e) || typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return bad();
      const ctx = sanitizeCtx(e.ctx);
      if (!ctx) return bad();
      events.push({ at: new Date(e.at).toISOString(), ctx });
    }
    for (const e of events) d.api.recordVehicleEvent(installId, e.ctx, e.at);
    return new Response(null, { status: 202 });
  }
  return null;
}

const todayKst = (): string => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 친구·초대·메시지·신고·일기 경로. 해당 없으면 null. 모든 조회는 토큰이 가리키는 계정(installId) 하나로만 좁힌다. */
async function handleSocial(req: Request, url: URL, path: string, m: string, me: string, d: ApiDeps): Promise<Response | null> {
  const s = d.social;

  if (path === "/v1/friends/invites" && m === "POST") {
    const inv = s.store.createInvite(me);
    return json({ code: inv.code, url: `${d.passengerWebUrl}/f/${inv.code}`, expiresAt: inv.expiresAt });
  }
  const accept = /^\/v1\/friends\/invites\/([^/]+)\/accept$/.exec(path);
  if (accept && m === "POST") {
    const code = accept[1]!.toUpperCase();
    if (!INVITE_CODE_RE.test(code)) return json({ error: "unknown" }, 404);
    const r = s.store.acceptInvite(code, me);
    if (!r.ok) return json({ error: r.reason }, r.reason === "unknown" ? 404 : r.reason === "expired" ? 410 : r.reason === "self" ? 400 : 409);
    return json({ friend: r.friend });
  }
  if (path === "/v1/friends" && m === "GET") return json(s.store.listFriends(me));
  const friend = /^\/v1\/friends\/([^/]+)$/.exec(path);
  if (friend) {
    const id = decodeURIComponent(friend[1]!);
    if (m === "DELETE") return s.store.removeFriend(me, id) ? noContent() : json({ error: "not_found" }, 404);
    if (m === "PATCH") {
      const b = await readJson(req);
      if (!isObj(b) || typeof b.shareArrival !== "boolean") return bad();
      const f = s.store.setShareArrival(me, id, b.shareArrival);
      return f ? json(f) : json({ error: "not_found" }, 404);
    }
    return null;
  }

  if (path === "/v1/messages" && m === "POST") {
    const b = await readJson(req);
    if (!isObj(b) || typeof b.toFriendId !== "string" || typeof b.text !== "string") return bad();
    const to = s.store.friendById(me, b.toFriendId);
    if (!to) return json({ error: "not_found" }, 404);
    const r = s.sendToAccount(me, to.account, b.text);
    if (r.ok) return json({ id: r.message.id, at: new Date(r.message.at).toISOString() }, 201);
    if (r.reason === "blocked") return json({ error: "message_blocked", code: "message_blocked" }, 422);
    return r.reason === "bad_text" ? json({ error: "bad_text", max: MAX_MESSAGE_CHARS }, 400) : json({ error: "not_found" }, 404);
  }
  if (path === "/v1/messages" && m === "GET") {
    const since = url.searchParams.get("since");
    const sinceMs = since ? Date.parse(since) : null;
    if (since && Number.isNaN(sinceMs)) return bad();
    return json({ messages: s.store.listMessages(me, sinceMs) });
  }
  const report = /^\/v1\/messages\/([^/]+)\/report$/.exec(path);
  if (report && m === "POST") return s.store.reportMessage(me, decodeURIComponent(report[1]!)) ? noContent() : json({ error: "not_found" }, 404);

  if (path === "/v1/diary" && m === "GET") {
    const date = url.searchParams.get("date") ?? todayKst();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad();
    return json({ date, entries: s.store.diaryEntries(me, date), summary: s.store.diarySummary(me, date) });
  }
  return null;
}
