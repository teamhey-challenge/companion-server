import { createHash, timingSafeEqual } from "node:crypto";
import { loadSecrets } from "./llm/secrets";

export interface GuardConfig {
  /** 차량 등록용 프로비전 비밀. undefined면 COMPANION_ALLOW_NO_AUTH=1 로 등록 검사를 끈 개발 모드다. */
  provisionSecret: string | undefined;
  trustProxy: boolean;
  turnsPerMin: number;
  turnsPerDay: number;
  upgradesPerMin: number;
  /** 등록·세션 발급 시도 한도(IP별, 분당) */
  httpPerMin: number;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 환경변수 + 600 권한 비밀 파일에서 접근 제어 설정을 읽는다. 값은 로그에 남기지 않는다.
 * 프로비전 비밀이 없으면 시작을 거부한다(fail-closed). 로컬 개발·시험만 COMPANION_ALLOW_NO_AUTH=1 로 끌 수 있다.
 */
export function loadGuardConfig(
  env: Record<string, string | undefined> = process.env,
  secrets: Record<string, string> = loadSecrets(),
): GuardConfig {
  const pick = (k: string) => env[k] || secrets[k] || undefined;
  const provisionSecret = pick("COMPANION_PROVISION_SECRET");
  if (!provisionSecret && pick("COMPANION_ALLOW_NO_AUTH") !== "1") {
    throw new Error("COMPANION_PROVISION_SECRET 이 없어 시작하지 않음 (개발용은 COMPANION_ALLOW_NO_AUTH=1)");
  }
  return {
    provisionSecret,
    trustProxy: pick("COMPANION_TRUST_PROXY") === "1",
    turnsPerMin: num(pick("COMPANION_TURNS_PER_MIN"), 20),
    turnsPerDay: num(pick("COMPANION_TURNS_PER_DAY"), 300),
    upgradesPerMin: num(pick("COMPANION_UPGRADES_PER_MIN"), 30),
    httpPerMin: num(pick("COMPANION_HTTP_PER_MIN"), 30),
  };
}

/** 길이와 무관하게 상수 시간으로 비교한다(해시 후 비교). */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

/** `Authorization: Bearer <t>` 의 토큰. 없으면 null. */
export function bearer(headers: Headers): string | null {
  return /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]?.trim() || null;
}

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

/** 프록시 헤더가 없는 루프백 요청만 내부 호출로 본다. */
export function isLocalRequest(headers: Headers, socketIp: string | undefined): boolean {
  if (headers.has("cf-connecting-ip") || headers.has("x-forwarded-for") || headers.has("forwarded")) return false;
  return socketIp !== undefined && LOOPBACK[socketIp] === true;
}

/** COMPANION_TRUST_PROXY=1 일 때만 프록시 헤더의 IP를 믿는다. */
export function clientIp(headers: Headers, socketIp: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
    const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  return socketIp ?? "unknown";
}
