import { loadSecrets } from "./llm/secrets";

export interface GuardConfig {
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
 * 등록은 비밀 없이 열려 있다(IP별 분당 한도만 적용).
 */
export function loadGuardConfig(
  env: Record<string, string | undefined> = process.env,
  secrets: Record<string, string> = loadSecrets(),
): GuardConfig {
  const pick = (k: string) => env[k] || secrets[k] || undefined;
  return {
    trustProxy: pick("COMPANION_TRUST_PROXY") === "1",
    turnsPerMin: num(pick("COMPANION_TURNS_PER_MIN"), 20),
    turnsPerDay: num(pick("COMPANION_TURNS_PER_DAY"), 300),
    upgradesPerMin: num(pick("COMPANION_UPGRADES_PER_MIN"), 30),
    httpPerMin: num(pick("COMPANION_HTTP_PER_MIN"), 30),
  };
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
