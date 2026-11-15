import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TTL_SEC,
  type CharacterInfo,
  type ConsentRecord,
  type ConsentType,
  type CurrentPairingResponse,
  type MemoryItem,
  type MemoryKind,
  type PublicPairingStatus,
  type Settings,
  type SettingsPatch,
} from "../shared/packages/protocol/src/index";
import type { Clock } from "./clock";

/** meetStage 0 처음 ~ 4 끝. lastGreetingDay는 차 시계 기준 날짜 문자열. */
export interface TalkState { meetStage: number; lastGreetingDay: string | null }
export const DEFAULT_TALK_STATE: TalkState = { meetStage: 0, lastGreetingDay: null };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
type MemRow = { seq: number; id: string; kind: MemoryKind; text: string; created_at: number };

/** 같은 기억 문장인지 볼 때 쓰는 모양: 공백 뭉치기·앞뒤 공백 제거·끝 문장부호 제거. */
export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[\s.!?。…~,]+$/u, "");
}
export const CHARACTER_NAME = "헤이리";
const MAX_EVENTS_PER_CAR = 200;

/** 꾸미기(D-41). Rive 계약(rive-rig.md): bodyColor 0 아쿠아·1 피치, hat 0 없음·1 비니(기본: 지금 보이는 모습)·2 버킷, neck 0 없음·1 스카프. bodyColor null = 테마를 따른다(라이트 0, 다크 1). */
export interface Look { bodyColor: 0 | 1 | null; hat: 0 | 1 | 2; neck: 0 | 1 }
export const LOOK_MAX = { bodyColor: 1, hat: 2, neck: 1 } as const;
export type ServerSettings = Settings & Look & { displayName: string };
/** displayName 은 nickname 의 읽기 전용 별칭이라 쓰기 대상이 아니다(한 사람 이름은 nickname 하나). */
export type ServerSettingsPatch = Partial<Settings & Look>;
/** 사용자 이름 한 칸의 상한(글자). 친구에게 보이는 이름도 같은 값이다. */
export const MAX_NAME_CHARS = 10;
export const FALLBACK_NAME = "친구";

export const DEFAULT_SETTINGS: ServerSettings = { proactive: "normal", memoryEnabled: true, speech: "banmal", nickname: null, bodyColor: null, hat: 1, neck: 0, displayName: FALLBACK_NAME };

export type Principal = { kind: "car" | "phone"; installId: string };

/** 차마다 같은 캐릭터 몸 색(0|1). installId 해시에서 정한다. */
export function characterFor(installId: string | null): CharacterInfo {
  const bodyColor = installId ? ((parseInt(sha256(installId).slice(0, 2), 16) & 1) as 0 | 1) : 0;
  return { name: CHARACTER_NAME, bodyColor };
}

export type ClaimResult =
  | { ok: true; phoneToken: string; character: CharacterInfo; installId: string; googleName: string | null }
  | { ok: false; reason: "unknown" | "already_used" | "expired" | "car_linked_to_other_account" | "google_linked_to_other_car" };

export type CurrentPairing = CurrentPairingResponse & { googleName?: string | null };

/**
 * 동의·페어링·기억·설정·차량 이벤트 저장소(같은 sqlite 파일). 동기 API(bun:sqlite).
 * 폰 토큰은 해시로만 저장한다. 기억 쓰기 포트(addMemory 등)는 ServerTalk의 TalkStore 모양과 같다.
 */
export class ApiStore {
  constructor(private readonly db: Database, private readonly clock: Clock) {
    db.run(`CREATE TABLE IF NOT EXISTS consents (
      install_id TEXT NOT NULL, type TEXT NOT NULL, version TEXT NOT NULL, granted INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (install_id, type))`);
    db.run(`CREATE TABLE IF NOT EXISTS pairings (
      code TEXT PRIMARY KEY, install_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      claimed_at INTEGER, phone_hash TEXT UNIQUE)`);
    db.run("CREATE INDEX IF NOT EXISTS pairings_car ON pairings (install_id, created_at)");
    db.run(`CREATE TABLE IF NOT EXISTS memory (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, install_id TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS memory_car ON memory (install_id, seq)");
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      install_id TEXT PRIMARY KEY, proactive TEXT NOT NULL, memory_enabled INTEGER NOT NULL, speech TEXT NOT NULL, nickname TEXT)`);
    const cols = (db.query("PRAGMA table_info(settings)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("body_color")) db.run("ALTER TABLE settings ADD COLUMN body_color INTEGER");
    if (!cols.includes("hat")) db.run("ALTER TABLE settings ADD COLUMN hat INTEGER NOT NULL DEFAULT 1");
    if (!cols.includes("neck")) db.run("ALTER TABLE settings ADD COLUMN neck INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("display_name")) db.run("ALTER TABLE settings ADD COLUMN display_name TEXT");
    // 이름은 nickname 한 칸이다. display_name 에만 있던 값을 한 번 옮기고, 이후 display_name 은 읽지도 쓰지도 않는다.
    db.run("UPDATE settings SET nickname = SUBSTR(TRIM(display_name), 1, 10) WHERE (nickname IS NULL OR TRIM(nickname) = '') AND display_name IS NOT NULL AND TRIM(display_name) <> ''");
    db.run("UPDATE settings SET display_name = NULL WHERE display_name IS NOT NULL");
    // checkin_time(D-52 이전 열)은 더 이상 읽거나 쓰지 않는다. 옛 DB 의 NULL 허용 열은 그대로 둔다.
    db.run("CREATE TABLE IF NOT EXISTS phone_accounts (account_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)");
    db.run(`CREATE TABLE IF NOT EXISTS vehicle_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, install_id TEXT NOT NULL, at TEXT NOT NULL, ctx TEXT NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS vehicle_events_car ON vehicle_events (install_id, seq)");
    db.run("CREATE TABLE IF NOT EXISTS talk_state (install_id TEXT PRIMARY KEY, state TEXT NOT NULL)");
    // 구글 로그인(D-55). sub 만 보관한다(이메일·사진 없음). 폰 전용 계정과 차 계정에 각각 최대 하나.
    db.run("CREATE TABLE IF NOT EXISTS google_phone (sub TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE)");
    db.run("CREATE TABLE IF NOT EXISTS google_car (install_id TEXT PRIMARY KEY, sub TEXT NOT NULL UNIQUE)");
    // 구글 given_name(표시용 이름)만. 이메일·사진은 받지 않는다.
    db.run("CREATE TABLE IF NOT EXISTS google_names (sub TEXT PRIMARY KEY, given_name TEXT NOT NULL)");
    // 새 로그인·재연결로 밀려난 폰 토큰(해시). 이 토큰의 요청은 401 signed_in_elsewhere 로 알려 준다.
    db.run("CREATE TABLE IF NOT EXISTS replaced_tokens (token_hash TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  /** 여러 저장 동작을 한 트랜잭션으로 묶는다(중첩 가능). */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- 동의 ----
  listConsents(installId: string): ConsentRecord[] {
    const rows = this.db.query("SELECT type, version, granted, at FROM consents WHERE install_id = ?1 ORDER BY at, type").all(installId) as {
      type: ConsentType; version: string; granted: number; at: number;
    }[];
    return rows.map((r) => ({ type: r.type, version: r.version, granted: r.granted === 1, at: iso(r.at) }));
  }

  /** record·memory 철회는 그 차의 기억과 요약을 바로 지운다. memory 철회는 기억 기능도 끄고, memory 동의가 철회·없음에서 새로 허용되면 켠다. 이미 허용된 상태의 반복 허용은 설정 토글을 건드리지 않는다. */
  setConsent(installId: string, type: ConsentType, version: string, granted: boolean, purge = true): void {
    const wasGranted = this.consentGranted(installId, type) === true;
    this.db
      .query(
        `INSERT INTO consents (install_id, type, version, granted, at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(install_id, type) DO UPDATE SET version = ?3, granted = ?4, at = ?5`,
      )
      .run(installId, type, version, granted ? 1 : 0, this.clock.now());
    if (granted && type === "memory" && !wasGranted) this.patchSettings(installId, { memoryEnabled: true });
    if (!granted && (type === "record" || type === "memory")) {
      if (type === "memory") this.patchSettings(installId, { memoryEnabled: false });
      if (!purge) return;
      this.deleteAllMemory(installId);
      this.db.query("DELETE FROM talk_state WHERE install_id = ?1").run(installId);
      // Review rule (user privacy): withdrawing consent deletes every stored item at once, not only memory rows.
      this.db.query("DELETE FROM vehicle_events WHERE install_id = ?1").run(installId);
      this.db.query("UPDATE settings SET nickname = NULL WHERE install_id = ?1").run(installId);
    }
  }

  /** 철회. 동의 기록이 없었으면 version "-"으로 철회 기록을 남긴다. */
  withdrawConsent(installId: string, type: ConsentType): void {
    const row = this.db.query("SELECT version FROM consents WHERE install_id = ?1 AND type = ?2").get(installId, type) as { version: string } | null;
    this.setConsent(installId, type, row?.version ?? "-", false);
  }

  private consentGranted(installId: string, type: ConsentType): boolean | null {
    const r = this.db.query("SELECT granted FROM consents WHERE install_id = ?1 AND type = ?2").get(installId, type) as { granted: number } | null;
    return r ? r.granted === 1 : null;
  }

  // ---- 페어링 ----
  /** 새 코드를 만들고 이 차의 앞선 대기 코드는 바로 만료시킨다. */
  createPairing(installId: string): { pairCode: string; expiresAt: string } {
    const now = this.clock.now();
    this.db.query("UPDATE pairings SET expires_at = ?2 WHERE install_id = ?1 AND claimed_at IS NULL AND expires_at > ?2").run(installId, now);
    const expires = now + PAIR_CODE_TTL_SEC * 1000;
    for (let i = 0; i < 20; i++) {
      const code = Array.from({ length: PAIR_CODE_LENGTH }, () => PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]).join("");
      try {
        this.db.query("INSERT INTO pairings (code, install_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").run(code, installId, now, expires);
        this.prunePairings(now);
        return { pairCode: code, expiresAt: iso(expires) };
      } catch {
        /* 코드 충돌: 다시 뽑는다 */
      }
    }
    throw new Error("pair code generation failed");
  }

  private replaceToken(oldHash: string | null | undefined): void {
    if (!oldHash) return;
    const now = this.clock.now();
    this.db.query("INSERT OR REPLACE INTO replaced_tokens (token_hash, at) VALUES (?1, ?2)").run(oldHash, now);
    this.db.query("DELETE FROM replaced_tokens WHERE at < ?1").run(now - 30 * 24 * 3600_000);
  }

  /** 다른 폰의 로그인·재연결로 밀려난 토큰인가. */
  isReplacedToken(token: string): boolean {
    return this.db.query("SELECT 1 AS x FROM replaced_tokens WHERE token_hash = ?1").get(sha256(token)) !== null;
  }

  private prunePairings(now: number): void {
    this.db.query("DELETE FROM pairings WHERE claimed_at IS NULL AND expires_at < ?1").run(now - 24 * 3600_000);
  }

  private googleNameOfCar(installId: string): string | null {
    const r = this.db.query("SELECT n.given_name AS name FROM google_car c JOIN google_names n ON n.sub = c.sub WHERE c.install_id = ?1").get(installId) as { name: string } | null;
    return r?.name ?? null;
  }

  currentPairing(installId: string): CurrentPairing {
    const now = this.clock.now();
    const claimed = this.db.query("SELECT claimed_at FROM pairings WHERE install_id = ?1 AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1").get(installId) as { claimed_at: number } | null;
    const latest = this.db.query("SELECT code, expires_at, claimed_at FROM pairings WHERE install_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(installId) as
      | { code: string; expires_at: number; claimed_at: number | null } | null;
    if (latest && latest.claimed_at === null && latest.expires_at > now) {
      return { status: "pending", pairCode: latest.code, expiresAt: iso(latest.expires_at) };
    }
    if (claimed) return { status: "claimed", pairedAt: iso(claimed.claimed_at), googleName: this.googleNameOfCar(installId) };
    if (latest) return { status: "expired", pairCode: latest.code, expiresAt: iso(latest.expires_at) };
    return { status: "none" };
  }

  publicPairing(code: string): { status: PublicPairingStatus; installId: string | null } {
    const r = this.db.query("SELECT install_id, expires_at, claimed_at FROM pairings WHERE code = ?1").get(code) as
      | { install_id: string; expires_at: number; claimed_at: number | null } | null;
    if (!r) return { status: "unknown", installId: null };
    if (r.claimed_at !== null) return { status: "claimed", installId: r.install_id };
    return { status: r.expires_at > this.clock.now() ? "pending" : "expired", installId: r.install_id };
  }

  /** 한 차에 폰 하나: 이전에 연결된 폰 토큰은 무효가 된다(그 폰은 signed_in_elsewhere). googleSub 가 있으면(구글 로그인 폰) 그 차에 묶고, 없으면 옛 묶음을 지운다. */
  claimPairing(code: string, record: boolean, memory: boolean, googleSub: string | null = null): ClaimResult {
    const p = this.publicPairing(code);
    if (p.status !== "pending" || !p.installId) return { ok: false, reason: p.status === "pending" ? "unknown" : p.status === "claimed" ? "already_used" : p.status };
    const installId = p.installId;
    if (googleSub !== null) {
      const bound = this.db.query("SELECT sub FROM google_car WHERE install_id = ?1").get(installId) as { sub: string } | null;
      if (bound && bound.sub !== googleSub) return { ok: false, reason: "car_linked_to_other_account" };
      const other = this.db.query("SELECT install_id FROM google_car WHERE sub = ?1").get(googleSub) as { install_id: string } | null;
      if (other && other.install_id !== installId) return { ok: false, reason: "google_linked_to_other_car" };
    }
    const now = this.clock.now();
    const phoneToken = randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      for (const o of this.db.query("SELECT phone_hash FROM pairings WHERE install_id = ?1 AND claimed_at IS NOT NULL").all(installId) as { phone_hash: string | null }[]) this.replaceToken(o.phone_hash);
      this.db.query("DELETE FROM pairings WHERE install_id = ?1 AND claimed_at IS NOT NULL").run(installId);
      this.db.query("UPDATE pairings SET claimed_at = ?2, phone_hash = ?3 WHERE code = ?1").run(code, now, sha256(phoneToken));
      // 폰 연결은 앞으로의 동의만 바꾼다. 체크를 끈 채 다시 연결해도 차의 기억·F2 상태는 지우지 않고(해제 때 기억 유지와 같은 규칙), 삭제는 DELETE /v1/consents 로만 한다.
      this.setConsent(installId, "record", "phone-claim", record, false);
      this.setConsent(installId, "memory", "phone-claim", memory, false);
      if (googleSub !== null) this.db.query("INSERT OR IGNORE INTO google_car (install_id, sub) VALUES (?1, ?2)").run(installId, googleSub);
      else this.db.query("DELETE FROM google_car WHERE install_id = ?1").run(installId);
    })();
    return { ok: true, phoneToken, character: characterFor(installId), installId, googleName: this.googleNameOfCar(installId) };
  }

  /** 연결 해제: 폰 토큰과 대기 코드를 지운다. 기억은 남긴다. */
  unpair(installId: string): void {
    this.db.query("DELETE FROM pairings WHERE install_id = ?1").run(installId);
    this.db.query("DELETE FROM google_car WHERE install_id = ?1").run(installId);
  }

  /** 구글 sub 로 로그인: 묶인 차 계정 → 폰 전용 계정 → 새 폰 전용 계정 순. 차 계정은 그 차의 폰 토큰을 새로 발급한다(차마다 폰 하나). */
  googleLogin(sub: string, givenName: string | null): { phoneToken: string; accountId: string; displayName: string; linkedCar: boolean; isNew: boolean } {
    const phoneToken = randomBytes(32).toString("base64url");
    return this.db.transaction(() => {
      if (givenName) {
        const gn = [...givenName].slice(0, MAX_NAME_CHARS).join("");
        this.db.query("INSERT INTO google_names (sub, given_name) VALUES (?1, ?2) ON CONFLICT(sub) DO UPDATE SET given_name = ?2").run(sub, gn);
      }
      const car = this.db.query("SELECT install_id FROM google_car WHERE sub = ?1").get(sub) as { install_id: string } | null;
      if (car) {
        const old = this.db.query("SELECT phone_hash FROM pairings WHERE install_id = ?1 AND claimed_at IS NOT NULL").get(car.install_id) as { phone_hash: string | null } | null;
        const r = this.db.query("UPDATE pairings SET phone_hash = ?2 WHERE install_id = ?1 AND claimed_at IS NOT NULL").run(car.install_id, sha256(phoneToken));
        if (r.changes > 0) {
          this.replaceToken(old?.phone_hash);
          return { phoneToken, accountId: car.install_id, displayName: this.displayNameOf(car.install_id), linkedCar: true, isNew: false };
        }
        this.db.query("DELETE FROM google_car WHERE install_id = ?1").run(car.install_id); // 연결이 사라진 묶음
      }
      const ph = this.db.query("SELECT account_id FROM google_phone WHERE sub = ?1").get(sub) as { account_id: string } | null;
      if (ph) {
        const old = this.db.query("SELECT token_hash FROM phone_accounts WHERE account_id = ?1").get(ph.account_id) as { token_hash: string } | null;
        this.db.query("UPDATE phone_accounts SET token_hash = ?2 WHERE account_id = ?1").run(ph.account_id, sha256(phoneToken));
        this.replaceToken(old?.token_hash);
        return { phoneToken, accountId: ph.account_id, displayName: this.displayNameOf(ph.account_id), linkedCar: false, isNew: false };
      }
      const name = givenName ? [...givenName].slice(0, MAX_NAME_CHARS).join("") : FALLBACK_NAME;
      const created = this.registerPhoneAccount(name);
      this.db.query("UPDATE phone_accounts SET token_hash = ?2 WHERE account_id = ?1").run(created.accountId, sha256(phoneToken));
      this.db.query("INSERT INTO google_phone (sub, account_id) VALUES (?1, ?2)").run(sub, created.accountId);
      return { phoneToken, accountId: created.accountId, displayName: name, linkedCar: false, isNew: true };
    })();
  }

  /** 구글 로그인으로 받은 토큰이면 그 sub(폰 전용 계정 토큰 또는 차에 묶인 폰 토큰), 아니면 null. */
  googleSubOfPhoneToken(token: string): string | null {
    const h = sha256(token);
    const r = this.db
      .query(
        `SELECT g.sub FROM phone_accounts a JOIN google_phone g ON g.account_id = a.account_id WHERE a.token_hash = ?1
         UNION SELECT c.sub FROM pairings p JOIN google_car c ON c.install_id = p.install_id WHERE p.phone_hash = ?1`,
      )
      .get(h) as { sub: string } | null;
    return r?.sub ?? null;
  }

  /** 이 차에 연결된 폰이 있나. */
  phoneLinked(installId: string): boolean {
    return this.db.query("SELECT 1 AS x FROM pairings WHERE install_id = ?1 AND claimed_at IS NOT NULL").get(installId) !== null;
  }

  /** 계정 요약: 차 계정(묶인 차)인지 폰 전용인지, 구글 이름, 연결 시각. */
  accountInfo(accountId: string): { accountKind: "car" | "phone"; googleName: string | null; pairedAt: string | null } {
    if (accountId.startsWith("ph_")) {
      const r = this.db.query("SELECT n.given_name AS name FROM google_phone p JOIN google_names n ON n.sub = p.sub WHERE p.account_id = ?1").get(accountId) as { name: string } | null;
      return { accountKind: "phone", googleName: r?.name ?? null, pairedAt: null };
    }
    const cur = this.currentPairing(accountId);
    return { accountKind: "car", googleName: this.googleNameOfCar(accountId), pairedAt: cur.status === "claimed" ? (cur.pairedAt ?? null) : null };
  }

  /** 폰만 쓰는 계정(차 없는 친구)을 만든다. 토큰은 해시로만 저장한다. */
  registerPhoneAccount(displayName: string): { phoneToken: string; accountId: string } {
    const accountId = `ph_${randomBytes(12).toString("base64url")}`;
    const phoneToken = randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      this.db.query("INSERT INTO phone_accounts (account_id, token_hash, created_at) VALUES (?1, ?2, ?3)").run(accountId, sha256(phoneToken), this.clock.now());
      this.patchSettings(accountId, { nickname: displayName });
    })();
    return { phoneToken, accountId };
  }

  phoneLookup(token: string): string | null {
    const h = sha256(token);
    const r = this.db.query("SELECT install_id FROM pairings WHERE phone_hash = ?1").get(h) as { install_id: string } | null;
    if (r) return r.install_id;
    const p = this.db.query("SELECT account_id FROM phone_accounts WHERE token_hash = ?1").get(h) as { account_id: string } | null;
    return p?.account_id ?? null;
  }

  /** 폰 로그아웃: 이 토큰 하나만 무효로 만든다. 기억·일기·친구·설정·구글 묶음은 그대로라 다시 로그인하면 돌아온다. 폰 전용 계정은 token_hash 를 아무도 낼 수 없는 값으로 바꾼다. */
  revokePhoneToken(token: string): void {
    const h = sha256(token);
    this.db.transaction(() => {
      this.db.query("UPDATE pairings SET phone_hash = NULL WHERE phone_hash = ?1").run(h);
      this.db.query("UPDATE phone_accounts SET token_hash = ?2 WHERE token_hash = ?1").run(h, `revoked:${randomBytes(16).toString("hex")}`);
    })();
  }

  // ---- 기억 ----
  addMemory(installId: string, kind: MemoryKind, text: string): MemoryItem {
    // 같은 차에 같은 문장(종류가 달라도)이 이미 있으면 새로 쓰지 않고 기존 항목을 돌려준다.
    const key = normalizeMemoryText(text);
    const rows = this.db.query("SELECT seq, id, kind, text, created_at FROM memory WHERE install_id = ?1 ORDER BY seq DESC").all(installId) as MemRow[];
    const dup = rows.find((r) => normalizeMemoryText(r.text) === key);
    if (dup) return { id: dup.id, kind: dup.kind, text: dup.text, createdAt: iso(dup.created_at) };
    const id = crypto.randomUUID();
    const now = this.clock.now();
    this.db.query("INSERT INTO memory (id, install_id, kind, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(id, installId, kind, text, now);
    return { id, kind, text, createdAt: iso(now) };
  }

  /** 최신순. 같은 문장(정규화 기준)은 가장 새 것 하나만 보인다(기존 중복 행은 지우지 않는다). cursor는 이전 쪽 마지막 항목의 seq. */
  pageMemory(installId: string, cursor: number | null, limit: number): { items: MemoryItem[]; nextCursor: string | null } {
    const rows = this.db.query("SELECT seq, id, kind, text, created_at FROM memory WHERE install_id = ?1 ORDER BY seq DESC").all(installId) as MemRow[];
    const seen = new Set<string>();
    const after = rows.filter((r) => {
      const k = normalizeMemoryText(r.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return r.seq < (cursor ?? Number.MAX_SAFE_INTEGER);
    });
    const page = after.slice(0, limit);
    return {
      items: page.map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: iso(r.created_at) })),
      nextCursor: after.length > limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  listMemory(installId: string, limit: number): MemoryItem[] {
    return this.pageMemory(installId, null, limit).items;
  }

  /** 보이는 항목을 지우면 같은 문장의 쌍둥이 행도 함께 지운다(안 그러면 숨은 쪽이 다시 나타난다). */
  deleteMemory(installId: string, id: string): boolean {
    const rows = this.db.query("SELECT id, text FROM memory WHERE install_id = ?1").all(installId) as { id: string; text: string }[];
    const target = rows.find((r) => r.id === id);
    if (!target) return false;
    const key = normalizeMemoryText(target.text);
    const del = this.db.query("DELETE FROM memory WHERE install_id = ?1 AND id = ?2");
    for (const r of rows) if (normalizeMemoryText(r.text) === key) del.run(installId, r.id);
    return true;
  }

  deleteAllMemory(installId: string): void {
    this.db.query("DELETE FROM memory WHERE install_id = ?1").run(installId);
  }

  // ---- 대화 상태(ServerTalk): 차마다 작은 JSON ----
  getTalkState(installId: string): TalkState {
    const r = this.db.query("SELECT state FROM talk_state WHERE install_id = ?1").get(installId) as { state: string } | null;
    return { ...DEFAULT_TALK_STATE, ...(r ? (JSON.parse(r.state) as Partial<TalkState>) : {}) };
  }

  patchTalkState(installId: string, patch: Partial<TalkState>): TalkState {
    const next = { ...this.getTalkState(installId), ...patch };
    this.db
      .query("INSERT INTO talk_state (install_id, state) VALUES (?1, ?2) ON CONFLICT(install_id) DO UPDATE SET state = ?2")
      .run(installId, JSON.stringify(next));
    return next;
  }

  // ---- 설정 ----
  getSettings(installId: string): ServerSettings {
    const r = this.db.query("SELECT proactive, memory_enabled, speech, nickname, body_color, hat, neck FROM settings WHERE install_id = ?1").get(installId) as
      | {
          proactive: Settings["proactive"]; memory_enabled: number; speech: Settings["speech"]; nickname: string | null;
          body_color: 0 | 1 | null; hat: 0 | 1 | 2; neck: 0 | 1;
        } | null;
    if (!r) return { ...DEFAULT_SETTINGS };
    return {
      proactive: r.proactive, memoryEnabled: r.memory_enabled === 1, speech: r.speech, nickname: r.nickname,
      bodyColor: r.body_color, hat: r.hat, neck: r.neck, displayName: r.nickname ?? FALLBACK_NAME,
    };
  }

  patchSettings(installId: string, patch: ServerSettingsPatch): ServerSettings {
    const s = { ...this.getSettings(installId), ...patch };
    this.db
      .query(
        `INSERT INTO settings (install_id, proactive, memory_enabled, speech, nickname, body_color, hat, neck) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(install_id) DO UPDATE SET proactive = ?2, memory_enabled = ?3, speech = ?4, nickname = ?5, body_color = ?6, hat = ?7, neck = ?8`,
      )
      .run(installId, s.proactive, s.memoryEnabled ? 1 : 0, s.speech, s.nickname, s.bodyColor, s.hat, s.neck);
    return { ...s, displayName: s.nickname ?? FALLBACK_NAME };
  }

  /** 친구에게 보이는 이름 = 헤이리가 부르는 이름(nickname), 없으면 "친구". */
  displayNameOf(installId: string): string {
    return this.getSettings(installId).displayName;
  }
  memoryAllowed(installId: string): boolean {
    return this.consentGranted(installId, "memory") === true && this.consentGranted(installId, "record") !== false && this.getSettings(installId).memoryEnabled;
  }

  /** 녹음과 외부 AI 처리 동의가 둘 다 있어야 말을 LLM·TTS 로 보낸다(AC-4.9-05). 기록이 없으면 거부다. */
  talkAllowed(installId: string): boolean {
    return this.consentGranted(installId, "record") === true && this.consentGranted(installId, "external_ai") === true;
  }

  // ---- 차량 이벤트(좌표는 호출 전에 버린다) ----
  recordVehicleEvent(installId: string, ctx: Record<string, unknown>, at: string = iso(this.clock.now())): void {
    this.db.query("INSERT INTO vehicle_events (install_id, at, ctx) VALUES (?1, ?2, ?3)").run(installId, at, JSON.stringify(ctx));
    this.db
      .query("DELETE FROM vehicle_events WHERE install_id = ?1 AND seq <= (SELECT seq FROM vehicle_events WHERE install_id = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)")
      .run(installId, MAX_EVENTS_PER_CAR);
  }

  lastVehicleContext(installId: string): Record<string, unknown> | null {
    const r = this.db.query("SELECT ctx FROM vehicle_events WHERE install_id = ?1 ORDER BY seq DESC LIMIT 1").get(installId) as { ctx: string } | null;
    return r ? (JSON.parse(r.ctx) as Record<string, unknown>) : null;
  }
}
