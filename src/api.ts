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
  type Settings,
  type SettingsPatch,
} from "../shared/packages/protocol/src/index";
import type { ApiStore, Principal } from "./api-store";
import { characterFor } from "./api-store";
import { bearer } from "./auth";
import type { CarStore } from "./store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const noContent = () => new Response(null, { status: 204 });
const bad = (error = "bad_request") => json({ error }, 400);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VEHICLE_EVENTS = 50;
const MAX_MEMORY_PAGE = 100;
const DEFAULT_MEMORY_PAGE = 50;
const SETTINGS_KEYS = ["proactive", "memoryEnabled", "speech", "nickname"] as const;

export interface ApiDeps {
  api: ApiStore;
  cars: CarStore;
  /** 설정이 바뀌면 그 차의 열린 소켓에 settings 프레임을 보낸다. */
  pushSettings?: (installId: string, settings: Settings) => void;
  /** 동의가 켜졌다: 그 차의 열린 소켓이 막혀 있던 첫 만남을 다시 시도하게 한다. */
  consentGranted?: (installId: string) => void;
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

function parsePatch(body: unknown): SettingsPatch | null {
  if (!isObj(body)) return null;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(k)) return null;
    if (k === "proactive" && !(PROACTIVE_LEVELS as readonly unknown[]).includes(v)) return null;
    if (k === "speech" && !(SPEECH_STYLES as readonly unknown[]).includes(v)) return null;
    if (k === "memoryEnabled" && typeof v !== "boolean") return null;
    if (k === "nickname") {
      if (v !== null && typeof v !== "string") return null;
      const t = typeof v === "string" ? v.trim() : null;
      if (t !== null && [...t].length > MAX_NICKNAME_CHARS) return null;
      patch[k] = t ? t : null;
      continue;
    }
    patch[k] = v;
  }
  return Object.keys(patch).length > 0 ? (patch as SettingsPatch) : null;
}

/** /v1/consents, /v1/pairings, /v1/memory, /v1/settings, /v1/vehicle-events. 해당 없으면 null. */
export async function handleApi(req: Request, url: URL, ip: string, d: ApiDeps): Promise<Response | null> {
  const path = url.pathname;
  const m = req.method;

  // ---- 토큰 없는 공개 경로(폰 연결 전) ----
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

  const known = /^\/v1\/(consents|pairings|memory|settings|vehicle-events)(\/|$)/.test(path);
  if (!known) return null;

  const who = authenticate(req, d);
  if (!who) {
    d.reject("api.unauthorized");
    return json({ error: "unauthorized" }, 401);
  }
  const { installId } = who;
  const carOnly = (): Response | null => (who.kind === "car" ? null : json({ error: "forbidden" }, 403));

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
    if (b.granted) d.consentGranted?.(installId);
    return json({ consents: d.api.listConsents(installId) });
  }
  const consent = /^\/v1\/consents\/([^/]+)$/.exec(path);
  if (consent && m === "DELETE") {
    if (!(CONSENT_TYPES as readonly string[]).includes(consent[1]!)) return bad();
    d.api.withdrawConsent(installId, consent[1] as ConsentType);
    return noContent();
  }

  if (path === "/v1/pairings" && m === "POST") return carOnly() ?? json(d.api.createPairing(installId));
  if (path === "/v1/pairings/current") {
    if (m === "GET") return carOnly() ?? json(d.api.currentPairing(installId));
    if (m === "DELETE") {
      const denied = carOnly();
      if (denied) return denied;
      d.api.unpair(installId);
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
    if (who.kind === "phone" && Object.keys(patch).some((k) => !(PHONE_SETTINGS_KEYS as readonly string[]).includes(k))) {
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
