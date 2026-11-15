import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Clock } from "./clock";

export const TICKET_TTL_SEC = 60;
const MAX_TICKETS = 10_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

/** 등록된 차량(installId → carToken 해시) 영속 저장. 토큰 원문은 저장하지 않는다. */
export class CarStore {
  readonly db: Database;

  constructor(path: string, private readonly clock: Clock) {
    if (path !== ":memory:") mkdirSync(path.replace(/\/[^/]*$/, "") || ".", { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS cars (install_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)",
    );
  }

  /** 같은 installId를 다시 등록하면 토큰이 새로 발급되고 이전 토큰은 무효가 된다. */
  register(installId: string): string {
    const token = secret();
    this.db
      .query(
        "INSERT INTO cars (install_id, token_hash, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(install_id) DO UPDATE SET token_hash = ?2, created_at = ?3",
      )
      .run(installId, sha256(token), this.clock.now());
    return token;
  }

  /** carToken → installId, 모르면 null. */
  lookup(token: string): string | null {
    const row = this.db.query("SELECT install_id FROM cars WHERE token_hash = ?1").get(sha256(token)) as { install_id: string } | null;
    return row?.install_id ?? null;
  }

  close(): void {
    this.db.close();
  }
}

export interface Ticket {
  sessionId: string;
  installId: string;
  /** 어느 소켓에 쓰는 티켓인가: 대화(/v1/talk) 또는 폰 받은편지함(/v1/inbox/stream) */
  channel: "talk" | "inbox" | "any";
  /** 티켓을 받은 쪽(차 앱 또는 폰) */
  kind: "car" | "phone";
}

/** 한 번만 쓸 수 있는 짧은 웹소켓 티켓. 메모리에만 둔다(재시작하면 새로 받으면 된다). */
export class TicketBook {
  private readonly tickets = new Map<string, Ticket & { exp: number }>();

  constructor(private readonly clock: Clock) {}

  issue(installId: string, channel: Ticket["channel"] = "talk", kind: Ticket["kind"] = "car"): Ticket & { wsTicket: string; expiresInSec: number } {
    const now = this.clock.now();
    for (const [k, v] of this.tickets) if (v.exp <= now) this.tickets.delete(k);
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value as string);
    const wsTicket = secret();
    const sessionId = crypto.randomUUID();
    this.tickets.set(sha256(wsTicket), { sessionId, installId, channel, kind, exp: now + TICKET_TTL_SEC * 1000 });
    return { sessionId, installId, channel, kind, wsTicket, expiresInSec: TICKET_TTL_SEC };
  }

  /** 성공하면 티켓은 즉시 지워진다. */
  consume(wsTicket: string): Ticket | null {
    const key = sha256(wsTicket);
    const t = this.tickets.get(key);
    if (!t) return null;
    this.tickets.delete(key);
    return t.exp > this.clock.now() ? { sessionId: t.sessionId, installId: t.installId, channel: t.channel, kind: t.kind } : null;
  }
}
