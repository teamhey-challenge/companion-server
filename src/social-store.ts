import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import { PAIR_CODE_ALPHABET } from "../shared/packages/protocol/src/index";
import type { Clock } from "./clock";

/** 초대 코드 6자, 24시간. */
export const INVITE_CODE_LENGTH = 6;
export const INVITE_TTL_MS = 24 * 3600_000;
export const MAX_FRIENDS = 50;
export const MAX_MESSAGE_CHARS = 120;
export const INVITE_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

const iso = (ms: number) => new Date(ms).toISOString();
/** 한국 시각(KST) 날짜 YYYY-MM-DD. */
export const kstDate = (ms: number): string => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

export interface Friend { id: string; name: string; since: string; shareArrival: boolean }
export interface MessageRow { id: string; from: string; to: string; text: string; at: number }
export interface MessageView { id: string; direction: "in" | "out"; friendId: string; friendName: string; text: string; at: string }
export type DiaryKind = "trip_start" | "trip_done" | "friend_message" | "charging";
export interface DiaryEntry { at: string; text: string; kind: DiaryKind }

export type AcceptResult =
  | { ok: true; friend: Friend }
  | { ok: false; reason: "unknown" | "expired" | "self" | "limit" | "already_friends" };

/** 친구·초대·메시지·신고·일기 저장소(같은 sqlite 파일). 계정 id = 차 installId 또는 폰 전용 계정 id. */
export class SocialStore {
  constructor(private readonly db: Database, private readonly clock: Clock, private readonly nameOf: (account: string) => string) {
    db.run(`CREATE TABLE IF NOT EXISTS friend_invites (
      code TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS friends (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, friend TEXT NOT NULL, since INTEGER NOT NULL, share_arrival INTEGER NOT NULL DEFAULT 0,
      UNIQUE (owner, friend))`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      text TEXT NOT NULL, at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0)`);
    db.run("CREATE INDEX IF NOT EXISTS messages_to ON messages (to_id, at)");
    db.run("CREATE INDEX IF NOT EXISTS messages_from ON messages (from_id, at)");
    db.run("CREATE TABLE IF NOT EXISTS message_reports (message_id TEXT NOT NULL, reporter TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (message_id, reporter))");
    db.run("CREATE TABLE IF NOT EXISTS diary_flags (account TEXT NOT NULL, date TEXT NOT NULL, flag TEXT NOT NULL, PRIMARY KEY (account, date, flag))");
    db.run("CREATE TABLE IF NOT EXISTS diary_places (account TEXT NOT NULL, date TEXT NOT NULL, place TEXT NOT NULL, PRIMARY KEY (account, date, place))");
    db.run(`CREATE TABLE IF NOT EXISTS diary_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, date TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS diary_entries_day ON diary_entries (account, date, at)");
    db.run("CREATE TABLE IF NOT EXISTS diary_summaries (account TEXT NOT NULL, date TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (account, date))");
    // 일기 쓰기가 실패한 날(서버 오류). 다음 운행 끝에 다시 쓴다.
    db.run("CREATE TABLE IF NOT EXISTS diary_pending (account TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (account, date))");
  }

  /** 지금은 친구가 아니지만 예전에 메시지를 주고받은 사람 중 이름이 맞는 사람이 있나("이제 친구가 아니라서 전할 수 없어"). */
  wasFriend(owner: string, spokenName: string): boolean {
    const n = spokenName.trim().replace(/[야아]$/u, "");
    if (!n) return false;
    const rows = this.db.query("SELECT DISTINCT CASE WHEN from_id = ?1 THEN to_id ELSE from_id END AS other FROM messages WHERE from_id = ?1 OR to_id = ?1").all(owner) as { other: string }[];
    return rows.some((r) => this.rowFor(owner, r.other) === null && (this.nameOf(r.other) === spokenName.trim() || this.nameOf(r.other) === n));
  }

  // ---- 초대 ----
  createInvite(owner: string): { code: string; expiresAt: string } {
    const now = this.clock.now();
    const expires = now + INVITE_TTL_MS;
    this.db.query("DELETE FROM friend_invites WHERE expires_at < ?1").run(now);
    for (let i = 0; i < 20; i++) {
      const code = Array.from({ length: INVITE_CODE_LENGTH }, () => PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]).join("");
      try {
        this.db.query("INSERT INTO friend_invites (code, owner, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").run(code, owner, now, expires);
        return { code, expiresAt: iso(expires) };
      } catch {
        /* 코드 충돌: 다시 뽑는다 */
      }
    }
    throw new Error("invite code generation failed");
  }

  /** 초대 코드를 만든 계정(없거나 지났으면 null). */
  inviteOwner(code: string): string | null {
    const r = this.db.query("SELECT owner FROM friend_invites WHERE code = ?1 AND expires_at > ?2").get(code, this.clock.now()) as { owner: string } | null;
    return r?.owner ?? null;
  }

  /** 초대를 받아들이면 서로 친구가 된다. 이미 친구면 그대로 돌려준다. 코드는 24시간 안에 여러 번 쓸 수 있다(여러 친구에게 같은 링크). */
  acceptInvite(code: string, who: string): AcceptResult {
    const inv = this.db.query("SELECT owner, expires_at FROM friend_invites WHERE code = ?1").get(code) as { owner: string; expires_at: number } | null;
    if (!inv) return { ok: false, reason: "unknown" };
    if (inv.expires_at <= this.clock.now()) return { ok: false, reason: "expired" };
    if (inv.owner === who) return { ok: false, reason: "self" };
    const now = this.clock.now();
    const mk = (owner: string, friend: string) =>
      this.db.query("INSERT INTO friends (id, owner, friend, since) VALUES (?1, ?2, ?3, ?4)").run(crypto.randomUUID(), owner, friend, now);
    const created = this.db.transaction((): "already" | "limit" | "created" => {
      if (this.rowFor(who, inv.owner)) return "already";
      if (this.count(who) >= MAX_FRIENDS || this.count(inv.owner) >= MAX_FRIENDS) return "limit";
      mk(who, inv.owner);
      mk(inv.owner, who);
      return "created";
    }).immediate();
    if (created === "limit") return { ok: false, reason: "limit" };
    if (created === "already") return { ok: false, reason: "already_friends" };
    return { ok: true, friend: this.view(this.rowFor(who, inv.owner)!) };
  }
  /** 폰 전용 계정에 친구·대화가 있나(차를 묶으면 옮겨지지 않는다는 확인 시트용). */
  phoneOnlyUsage(account: string): { friends: number; messages: number; hasData: boolean } {
    const friends = this.count(account);
    const m = this.db.query("SELECT COUNT(*) AS n FROM messages WHERE from_id = ?1 OR to_id = ?1").get(account);
    const messages = m !== null && typeof m === "object" && "n" in m && typeof m.n === "number" ? m.n : 0;
    return { friends, messages, hasData: friends > 0 || messages > 0 };
  }


  private count(owner: string): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM friends WHERE owner = ?1").get(owner);
    return r !== null && typeof r === "object" && "n" in r && typeof r.n === "number" ? r.n : 0;
  }

  /** owner 쪽에서 본 other 의 친구 행 id(둘이 친구가 아니면 null). */
  friendIdOf(owner: string, other: string): string | null {
    return this.rowFor(owner, other)?.id ?? null;
  }

  private rowFor(owner: string, friend: string): FriendRow | null {
    return this.db.query("SELECT id, owner, friend, since, share_arrival FROM friends WHERE owner = ?1 AND friend = ?2").get(owner, friend) as FriendRow | null;
  }
  /** 내 친구들의 (id, 이름, 계정). 말로 보내기에서 이름을 맞추는 데 쓴다. */
  friendAccounts(owner: string): { id: string; name: string; account: string }[] {
    const rows = this.db.query("SELECT id, friend FROM friends WHERE owner = ?1 ORDER BY since, rowid").all(owner) as { id: string; friend: string }[];
    return rows.map((r) => ({ id: r.id, name: this.nameOf(r.friend), account: r.friend }));
  }

  private view(r: FriendRow): Friend {
    return { id: r.id, name: this.nameOf(r.friend), since: iso(r.since), shareArrival: r.share_arrival === 1 };
  }

  // ---- 친구 ----
  listFriends(owner: string): Friend[] {
    const rows = this.db.query("SELECT id, owner, friend, since, share_arrival FROM friends WHERE owner = ?1 ORDER BY since, rowid").all(owner) as FriendRow[];
    return rows.map((r) => this.view(r));
  }

  /** 내 친구 한 칸(id 는 내 쪽 행 id). */
  friendById(owner: string, id: string): { friend: Friend; account: string } | null {
    const r = this.db.query("SELECT id, owner, friend, since, share_arrival FROM friends WHERE owner = ?1 AND id = ?2").get(owner, id) as FriendRow | null;
    return r ? { friend: this.view(r), account: r.friend } : null;
  }

  /** 친구 끊기: 양쪽 행을 지운다. */
  removeFriend(owner: string, id: string): boolean {
    const r = this.friendById(owner, id);
    if (!r) return false;
    this.db.transaction(() => {
      this.db.query("DELETE FROM friends WHERE owner = ?1 AND friend = ?2").run(owner, r.account);
      this.db.query("DELETE FROM friends WHERE owner = ?1 AND friend = ?2").run(r.account, owner);
    })();
    return true;
  }

  setShareArrival(owner: string, id: string, share: boolean): Friend | null {
    const r = this.friendById(owner, id);
    if (!r) return null;
    this.db.query("UPDATE friends SET share_arrival = ?3 WHERE owner = ?1 AND id = ?2").run(owner, id, share ? 1 : 0);
    return this.friendById(owner, id)!.friend;
  }

  /** 내가 도착을 알리기로 한 친구 계정들. */
  arrivalRecipients(owner: string): string[] {
    return (this.db.query("SELECT friend FROM friends WHERE owner = ?1 AND share_arrival = 1").all(owner) as { friend: string }[]).map((r) => r.friend);
  }

  // ---- 메시지 ----
  addMessage(from: string, to: string, text: string): MessageRow {
    const row = { id: crypto.randomUUID(), from, to, text, at: this.clock.now() };
    this.db.query("INSERT INTO messages (id, from_id, to_id, text, at) VALUES (?1, ?2, ?3, ?4, ?5)").run(row.id, from, to, text, row.at);
    return row;
  }

  /** 받은 것(신고된 것 제외)과 보낸 것, 최신순. 지금 친구인 사람과 주고받은 것만 보인다. */
  listMessages(me: string, sinceMs: number | null, limit = 100): MessageView[] {
    const rows = this.db
      .query(
        `SELECT id, from_id, to_id, text, at, reported FROM messages
         WHERE (to_id = ?1 AND reported = 0 OR from_id = ?1) AND at > ?2 ORDER BY seq DESC LIMIT ?3`,
      )
      .all(me, sinceMs ?? 0, limit * 2) as { id: string; from_id: string; to_id: string; text: string; at: number }[];
    const out: MessageView[] = [];
    for (const r of rows) {
      const outgoing = r.from_id === me;
      const other = outgoing ? r.to_id : r.from_id;
      const fr = this.rowFor(me, other);
      if (!fr) continue;
      out.push({ id: r.id, direction: outgoing ? "out" : "in", friendId: fr.id, friendName: this.nameOf(other), text: r.text, at: iso(r.at) });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 받은 사람만 신고할 수 있다. 신고하면 숨겨진다. */
  reportMessage(me: string, id: string): boolean {
    const m = this.db.query("SELECT to_id FROM messages WHERE id = ?1").get(id) as { to_id: string } | null;
    if (!m || m.to_id !== me) return false;
    this.db.query("UPDATE messages SET reported = 1 WHERE id = ?1").run(id);
    this.db.query("INSERT OR IGNORE INTO message_reports (message_id, reporter, at) VALUES (?1, ?2, ?3)").run(id, me, this.clock.now());
    return true;
  }

  markDelivered(id: string): void {
    this.db.query("UPDATE messages SET delivered = 1 WHERE id = ?1").run(id);
  }

  /** 아직 소리로 못 읽어 준 받은 메시지(신고된 것 제외), 오래된 것부터. */
  undelivered(to: string, sinceMs: number, limit: number): MessageRow[] {
    const rows = this.db
      .query("SELECT id, from_id, to_id, text, at FROM messages WHERE to_id = ?1 AND delivered = 0 AND reported = 0 AND at > ?2 ORDER BY seq LIMIT ?3")
      .all(to, sinceMs, limit) as { id: string; from_id: string; to_id: string; text: string; at: number }[];
    return rows.map((r) => ({ id: r.id, from: r.from_id, to: r.to_id, text: r.text, at: r.at }));
  }

  /** 가장 최근에 받은 메시지의 보낸 사람(고맙다고 전해 줘 답장 대상). maxAgeMs 안의 것만. */
  lastIncomingFrom(to: string, sinceMs: number): string | null {
    const r = this.db.query("SELECT from_id FROM messages WHERE to_id = ?1 AND reported = 0 AND at > ?2 ORDER BY seq DESC LIMIT 1").get(to, sinceMs);
    return r !== null && typeof r === "object" && "from_id" in r && typeof r.from_id === "string" ? r.from_id : null;
  }

  addFlag(account: string, date: string, flag: string): void {
    this.db.query("INSERT OR IGNORE INTO diary_flags (account, date, flag) VALUES (?1, ?2, ?3)").run(account, date, flag);
  }

  flags(account: string, date: string): string[] {
    return (this.db.query("SELECT flag FROM diary_flags WHERE account = ?1 AND date = ?2").all(account, date) as { flag: string }[]).map((r) => r.flag);
  }

  addPlace(account: string, date: string, place: string): void {
    this.db.query("INSERT OR IGNORE INTO diary_places (account, date, place) VALUES (?1, ?2, ?3)").run(account, date, place);
  }

  diaryPlaces(account: string, date: string): string[] {
    return (this.db.query("SELECT place FROM diary_places WHERE account = ?1 AND date = ?2").all(account, date) as { place: string }[]).map((r) => r.place);
  }

  // ---- 일기 ----
  addDiaryEntry(account: string, kind: DiaryKind, text: string, date?: string): void {
    const at = this.clock.now();
    this.db.query("INSERT INTO diary_entries (account, date, at, kind, text) VALUES (?1, ?2, ?3, ?4, ?5)").run(account, date ?? kstDate(at), at, kind, text);
  }

  /** 일기 쓰기가 실패한 날을 적어 둔다(다음 운행 끝에 다시 쓴다). */
  markDiaryPending(account: string, date: string): void {
    this.db.query("INSERT OR IGNORE INTO diary_pending (account, date) VALUES (?1, ?2)").run(account, date);
  }

  clearDiaryPending(account: string, date: string): void {
    this.db.query("DELETE FROM diary_pending WHERE account = ?1 AND date = ?2").run(account, date);
  }

  pendingDiaryDates(account: string): string[] {
    return (this.db.query("SELECT date FROM diary_pending WHERE account = ?1 ORDER BY date").all(account) as { date: string }[]).map((r) => r.date);
  }

  diaryEntries(account: string, date: string): DiaryEntry[] {
    const rows = this.db.query("SELECT at, kind, text FROM diary_entries WHERE account = ?1 AND date = ?2 ORDER BY at, seq").all(account, date) as { at: number; kind: DiaryKind; text: string }[];
    return rows.map((r) => ({ at: iso(r.at), text: r.text, kind: r.kind }));
  }

  diarySummary(account: string, date: string): string | null {
    return (this.db.query("SELECT summary FROM diary_summaries WHERE account = ?1 AND date = ?2").get(account, date) as { summary: string } | null)?.summary ?? null;
  }

  setDiarySummary(account: string, date: string, summary: string): void {
    this.db
      .query("INSERT INTO diary_summaries (account, date, summary) VALUES (?1, ?2, ?3) ON CONFLICT(account, date) DO UPDATE SET summary = ?3")
      .run(account, date, summary);
  }

  /** 동의 철회: 일기(항목·요약·재료)와 이 계정이 보내거나 받은 친구 메시지를 모두 지운다. 친구 관계는 그대로 둔다. */
  deleteAccountData(account: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM diary_entries WHERE account = ?1").run(account);
      this.db.query("DELETE FROM diary_summaries WHERE account = ?1").run(account);
      this.db.query("DELETE FROM diary_pending WHERE account = ?1").run(account);
      this.db.query("DELETE FROM diary_flags WHERE account = ?1").run(account);
      this.db.query("DELETE FROM diary_places WHERE account = ?1").run(account);
      this.db.query("DELETE FROM message_reports WHERE message_id IN (SELECT id FROM messages WHERE from_id = ?1 OR to_id = ?1)").run(account);
      this.db.query("DELETE FROM messages WHERE from_id = ?1 OR to_id = ?1").run(account);
    })();
  }
}

interface FriendRow { id: string; owner: string; friend: string; since: number; share_arrival: number }
