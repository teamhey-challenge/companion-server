import {
  CONSENT_TYPES,
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
import { LOOK_MAX, MAX_NAME_CHARS, characterFor } from "./api-store";
import { bearer } from "./auth";
import type { GoogleVerifier } from "./google";
import { messageBlocked, type Social } from "./social";
import { INVITE_CODE_RE, MAX_MESSAGE_CHARS } from "./social-store";
import type { CarStore, TicketBook } from "./store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const noContent = () => new Response(null, { status: 204 });
const bad = (error = "bad_request") => json({ error }, 400);
const err = (code: string, status: number) => json({ error: code, code }, status);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VEHICLE_EVENTS = 50;
const MAX_MEMORY_PAGE = 100;
const DEFAULT_MEMORY_PAGE = 50;
const SETTINGS_KEYS = ["proactive", "memoryEnabled", "speech", "nickname", "bodyColor", "hat", "neck", "displayName"] as const;
/** 폰 토큰이 바꿀 수 있는 설정(공유 규칙의 speech 에 더해). 이름은 nickname 한 칸이다. */
const PHONE_KEYS: readonly string[] = [...PHONE_SETTINGS_KEYS, "nickname"];

/** 이름 검증: 1~10자, 숫자만은 안 됨, 안전 필터 통과. 입력은 이미 trim 한 값. */
export function validName(t: string): boolean {
  return t.length > 0 && [...t].length <= MAX_NAME_CHARS && !/^\d+$/.test(t) && !messageBlocked(t);
}

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
  /** 폰이 연결되면 그 차의 열린 소켓에 pairing(linked, googleName) 프레임을 보낸다. */
  pushLinked?: (installId: string, googleName: string | null) => void;
  /** e2e 전용(COMPANION_ALLOW_NONGOOGLE_CLAIM=1): 구글이 아닌 폰 토큰의 연결(claim)도 받는다. 운영은 꺼 둔다(D-57). */
  allowNonGoogleClaim?: boolean;
  /** 시험 전용(COMPANION_ALLOW_PHONE_ONLY=1): 차 없는 폰 전용 계정을 등록·사용할 수 있다. 운영은 끈다(D-58). */
  allowPhoneOnly?: boolean;
  /** 동의가 바뀌면 그 차의 열린 소켓이 미뤄 둔 첫 정차 인사·첫 만남을 이어 간다. */
  consentChanged?: (installId: string, withdrawn: boolean) => void;
  /** 공개 엔드포인트(코드 조회·claim) 열거 방지용 IP별 제한. true면 거절. */
  throttled: (ip: string, bucket: string, max: number) => boolean;
  publicPerMin: number;
  reject: (reason: string) => void;
  /** GOOGLE_WEB_CLIENT_ID 가 없으면 null → /v1/auth/google 은 503. */
  google: GoogleVerifier | null;
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
    if (k === "nickname" || k === "displayName") {
      // 이름은 nickname 한 칸이다. displayName 은 옛 폰 앱이 보내는 별칭이라 같은 칸에 쓴다.
      if (k === "nickname" && v === null) {
        patch.nickname = null;
        continue;
      }
      const t = typeof v === "string" ? v.trim() : "";
      if (!validName(t)) return null;
      patch.nickname = t;
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
  if (path === "/v1/auth/google" && m === "POST") {
    if (d.throttled(ip, "gauth", d.publicPerMin)) return err("rate_limited", 429);
    if (!d.google) return json({ error: "google_login_unconfigured", code: "google_login_unconfigured" }, 503);
    const b = await readJson(req);
    if (!isObj(b) || typeof b.idToken !== "string" || b.idToken.length === 0 || b.idToken.length > 8192) return bad();
    const v = await d.google.verify(b.idToken);
    if (!v.ok) {
      d.reject(`google.${v.reason}`);
      return err("google_verify_failed", v.reason === "jwks_unavailable" ? 503 : 401);
    }
    return json(d.api.googleLogin(v.claims.sub, v.claims.givenName));
  }
  if (path === "/v1/phones/register" && m === "POST") {
    if (!d.allowPhoneOnly) return err("car_link_required", 403);
    if (d.throttled(ip, "phreg", d.publicPerMin)) return err("rate_limited", 429);
    const b = await readJson(req);
    const name = isObj(b) && typeof b.displayName === "string" ? b.displayName.trim() : "";
    if (!validName(name)) return bad();
    return json(d.api.registerPhoneAccount(name));
  }
  const pub = /^\/v1\/pairings\/([^/]+)(\/claim)?$/.exec(path);
  if (pub && pub[1] !== "current") {
    const code = pub[1]!;
    const isClaim = pub[2] !== undefined;
    if (isClaim ? m !== "POST" : m !== "GET") return null;
    if (d.throttled(ip, isClaim ? "claim" : "pairget", d.publicPerMin)) return err("rate_limited", 429);
    if (!isClaim) {
      const p = PAIR_CODE_RE.test(code) ? d.api.publicPairing(code) : { status: "unknown" as const, installId: null };
      return json({ status: p.status, character: characterFor(p.installId) });
    }
    const body = await readJson(req);
    if (!isObj(body) || typeof body.record !== "boolean" || typeof body.memory !== "boolean") return bad();
    if (!body.record) return err("record_consent_required", 400);
    if (!PAIR_CODE_RE.test(code)) return err("unknown", 404);
    const bearerToken = bearer(req.headers);
    if (bearerToken && d.api.isReplacedToken(bearerToken)) return err("signed_in_elsewhere", 401);
    const googleSub = bearerToken ? d.api.googleSubOfPhoneToken(bearerToken) : null;
    if (googleSub === null && !d.allowNonGoogleClaim) return err("google_login_required", 403);
    const r = d.api.claimPairing(code, body.record, body.memory, googleSub);
    if (!r.ok) return err(r.reason, r.reason === "unknown" ? 404 : r.reason === "expired" ? 410 : 409);
    d.pushLinked?.(r.installId, r.googleName);
    return json({ phoneToken: r.phoneToken, character: r.character });
  }

  const known = /^\/v1\/(consents|pairings|memory|settings|vehicle-events|friends|messages|diary|phone-sessions|account)(\/|$)/.test(path);
  if (!known) return null;

  const who = authenticate(req, d);
  if (!who) {
    const t = bearer(req.headers);
    if (t && d.api.isReplacedToken(t)) {
      d.reject("api.signed_in_elsewhere");
      return err("signed_in_elsewhere", 401);
    }
    d.reject("api.unauthorized");
    return json({ error: "unauthorized" }, 401);
  }
  const { installId } = who;
  const carOnly = (): Response | null => (who.kind === "car" ? null : json({ error: "forbidden" }, 403));
  // D-58: 차와 연결되지 않은 폰 토큰(폰 전용 계정)은 계정 조회·동의·연결 해제만 쓴다(연결 claim 은 토큰 없는 공개 경로에서 처리).
  if (who.kind === "phone" && installId.startsWith("ph_") && !d.allowPhoneOnly) {
    const open =
      (path === "/v1/account" && m === "GET") ||
      (/^\/v1\/consents(\/|$)/.test(path) && (m === "GET" || m === "POST" || m === "DELETE")) ||
      (path === "/v1/pairings/current" && m === "DELETE") ||
      (path === "/v1/phone-sessions/current" && m === "DELETE");
    if (!open) {
      d.reject("api.car_link_required");
      return err("car_link_required", 403);
    }
  }

  if (path === "/v1/phone-sessions/current" && m === "DELETE") {
    if (who.kind !== "phone") return json({ error: "forbidden" }, 403);
    const t = bearer(req.headers);
    if (t) d.api.revokePhoneToken(t);
    return noContent();
  }

  if (path === "/v1/phone-sessions" && m === "POST") {
    if (who.kind !== "phone") return json({ error: "forbidden" }, 403);
    if (d.throttled(ip, "phses", d.publicPerMin * 3)) return err("rate_limited", 429);
    const t = d.tickets.issue(installId, "any", "phone");
    return json({ sessionId: t.sessionId, wsTicket: t.wsTicket, expiresInSec: t.expiresInSec });
  }

  if (path === "/v1/account" && m === "GET") {
    if (who.kind !== "phone") return json({ error: "forbidden" }, 403);
    const info = d.api.accountInfo(installId);
    const phoneOnly = info.accountKind === "phone" ? d.social.store.phoneOnlyUsage(installId) : null;
    return json({ accountKind: info.accountKind, linkedCar: info.accountKind === "car", displayName: d.api.displayNameOf(installId), googleName: info.googleName, pairedAt: info.pairedAt, phoneOnly });
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
    const purge = !b.granted && (b.type === "record" || b.type === "memory");
    d.api.atomically(() => {
      d.api.setConsent(installId, b.type as ConsentType, b.version as string, b.granted as boolean);
      // D-53: 기억·녹음 동의 철회는 일기와 친구 메시지도 바로 지운다.
      if (purge) d.social.store.deleteAccountData(installId);
    });
    d.consentChanged?.(installId, !b.granted);
    return json({ consents: d.api.listConsents(installId) });
  }
  const consent = /^\/v1\/consents\/([^/]+)$/.exec(path);
  if (consent && m === "DELETE") {
    if (!(CONSENT_TYPES as readonly string[]).includes(consent[1]!)) return bad();
    const type = consent[1] as ConsentType;
    d.api.atomically(() => {
      d.api.withdrawConsent(installId, type);
      if (type === "record" || type === "memory") d.social.store.deleteAccountData(installId);
    });
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
  // 대체됨: 친구 요청(POST /v1/friends/requests → 수락)이 새 흐름이다. 차가 이미 병합해 쓰므로 당분간 즉시 친구 맺기를 남겨 둔다.
  const accept = /^\/v1\/friends\/invites\/([^/]+)\/accept$/.exec(path);
  if (accept && m === "POST") {
    const code = accept[1]!.toUpperCase();
    if (!INVITE_CODE_RE.test(code)) return err("unknown", 404);
    if (!d.allowPhoneOnly && s.store.inviteOwner(code)?.startsWith("ph_")) return err("unknown", 404);
    const r = s.store.acceptInvite(code, me);
    if (!r.ok) return err(r.reason, r.reason === "unknown" ? 404 : r.reason === "expired" ? 410 : r.reason === "self" ? 400 : 409);
    return json({ friend: r.friend });
  }

  if (path === "/v1/friends/requests") {
    if (m === "POST") {
      if (d.throttled(me, "freq", d.publicPerMin)) return err("rate_limited", 429);
      const b = await readJson(req);
      if (!isObj(b) || typeof b.code !== "string") return bad();
      const code = b.code.replace(/\s+/g, "").toUpperCase();
      if (!INVITE_CODE_RE.test(code)) return err("unknown_code", 404);
      if (!d.allowPhoneOnly && s.store.inviteOwner(code)?.startsWith("ph_")) return err("unknown_code", 404);
      const r = s.store.sendRequest(code, me);
      if (!r.ok) return err(r.reason, r.reason === "unknown_code" ? 404 : r.reason === "expired_code" ? 410 : 409);
      if (!r.existing) s.notifyFriend(r.to, { type: "friend_request", id: r.id, fromName: d.api.displayNameOf(me) });
      return json({ id: r.id, to: { name: d.api.displayNameOf(r.to) }, createdAt: r.createdAt }, r.existing ? 200 : 201);
    }
    if (m === "GET") {
      const l = s.store.listRequests(me);
      return json({
        incoming: l.incoming.map((r) => ({ id: r.id, from: { id: r.fromAccount, name: d.api.displayNameOf(r.fromAccount) }, createdAt: r.createdAt })),
        outgoing: l.outgoing.map((r) => ({ id: r.id, to: { name: d.api.displayNameOf(r.toAccount) }, createdAt: r.createdAt })),
      });
    }
    return null;
  }
  const reqAct = /^\/v1\/friends\/requests\/([^/]+)(?:\/(accept|decline))?$/.exec(path);
  if (reqAct) {
    const id = decodeURIComponent(reqAct[1]!);
    const act = reqAct[2];
    if (act === "accept" && m === "POST") {
      const r = s.store.acceptRequest(id, me);
      if (!r.ok) return err(r.reason, r.reason === "not_found" ? 404 : 409);
      s.notifyFriend(r.fromAccount, { type: "friend_accepted", id, name: d.api.displayNameOf(me) });
      return json({ friend: r.friend });
    }
    if (act === "decline" && m === "POST") return s.store.removeRequest(id, me, "to") ? noContent() : err("not_found", 404);
    if (!act && m === "DELETE") return s.store.removeRequest(id, me, "from") ? noContent() : err("not_found", 404);
    return null;
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
    if (r.reason === "blocked") return err("message_blocked", 422);
    return r.reason === "bad_text" || r.reason === "too_long" ? json({ error: "bad_text", code: "bad_text", max: MAX_MESSAGE_CHARS }, 400) : err("not_found", 404);
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
