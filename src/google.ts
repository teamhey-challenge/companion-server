import type { Clock } from "./clock";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const DEFAULT_TTL_MS = 3600_000;
/** 모르는 kid 때문에 키 목록을 다시 받는 간격 하한(없는 kid 로 구글을 두드리지 못하게). */
const REFETCH_MIN_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;

export type GoogleClaims = { sub: string; givenName: string | null };
export type GoogleVerifyResult = { ok: true; claims: GoogleClaims } | { ok: false; reason: "invalid_token" | "jwks_unavailable" };

const b64url = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64url"));
const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 구글 ID 토큰(RS256) 검증. 키는 kid 별로 캐시하고 cache-control max-age 를 따른다. 토큰·sub 는 기록하지 않는다. */
export class GoogleVerifier {
  private keys = new Map<string, CryptoKey>();
  private expiresAt = 0;
  private fetchedAt = -Infinity;
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly url: string = GOOGLE_JWKS_URL,
  ) {}

  private refresh(): Promise<boolean> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<boolean> {
    this.fetchedAt = this.clock.now();
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return false;
      const body = (await res.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) return false;
      const next = new Map<string, CryptoKey>();
      for (const k of body.keys) {
        if (!isObj(k) || typeof k.kid !== "string" || k.kty !== "RSA") continue;
        try {
          next.set(k.kid, await crypto.subtle.importKey("jwk", k as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
        } catch {
          /* 못 읽는 키는 건너뛴다 */
        }
      }
      if (next.size === 0) return false;
      const age = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
      this.keys = next;
      this.expiresAt = this.clock.now() + (age ? Number(age[1]) * 1000 : DEFAULT_TTL_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async keyFor(kid: string): Promise<CryptoKey | "unavailable" | null> {
    const now = this.clock.now();
    if (now >= this.expiresAt) {
      if (!(await this.refresh()) && this.keys.size === 0) return "unavailable";
    } else if (!this.keys.has(kid) && now - this.fetchedAt >= REFETCH_MIN_MS) {
      await this.refresh();
    }
    return this.keys.get(kid) ?? null;
  }

  async verify(idToken: string): Promise<GoogleVerifyResult> {
    const bad = { ok: false, reason: "invalid_token" } as const;
    const parts = idToken.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return bad;
    const header = parseJson(parts[0]!);
    const payload = parseJson(parts[1]!);
    if (!isObj(header) || !isObj(payload)) return bad;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return bad;
    const key = await this.keyFor(header.kid);
    if (key === "unavailable") return { ok: false, reason: "jwks_unavailable" };
    if (!key) return bad;
    const sigOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)).catch(() => false);
    if (!sigOk) return bad;
    if (typeof payload.iss !== "string" || !ISSUERS.has(payload.iss)) return bad;
    const aud = payload.aud;
    if (!(aud === this.clientId || (Array.isArray(aud) && aud.includes(this.clientId)))) return bad;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= this.clock.now()) return bad;
    if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) return bad;
    const given = typeof payload.given_name === "string" ? payload.given_name.trim() : "";
    return { ok: true, claims: { sub: payload.sub, givenName: given || null } };
  }
}
