import type { SpeechStyle } from "../shared/packages/protocol/src/index";
import type { ApiStore } from "./api-store";
import type { Clock } from "./clock";
import { friendArrivedLine, friendSaid, tripDoneLine } from "./lines";
import type { Observability } from "./observe";
import { checkInput, checkOutput } from "./safety";
import { MAX_MESSAGE_CHARS, SocialStore, kstDate, type MessageRow } from "./social-store";
import { splitSentences } from "./sentence-cap";
import type { FriendPush, TalkHub } from "./talk";

/** 폰 받은편지함 소켓이 보내는 말 */
export interface InboxSocket { send(s: string): unknown; data: { installId: string } }

export class InboxHub {
  private readonly socks = new Map<string, Set<InboxSocket>>();
  add(ws: InboxSocket): void {
    const set = this.socks.get(ws.data.installId) ?? new Set<InboxSocket>();
    set.add(ws);
    this.socks.set(ws.data.installId, set);
  }
  remove(ws: InboxSocket): void {
    const set = this.socks.get(ws.data.installId);
    set?.delete(ws);
    if (set?.size === 0) this.socks.delete(ws.data.installId);
  }
  push(account: string, frame: object): number {
    const msg = JSON.stringify(frame);
    const set = this.socks.get(account);
    for (const ws of set ?? []) ws.send(msg);
    return set?.size ?? 0;
  }
}

/** 메시지 입력 안전 필터. 위험·성적·혐오·자해 말, 욕설, 링크는 보내지 않는다. */
const PROFANITY = /(씨발|시발|ㅅㅂ|병신|ㅂㅅ|좆|개새끼|지랄|꺼져|죽어라|뒤져라|느금|애미|패드립)/;
const LINK = /(https?:\/\/|www\.|\.(com|net|kr|io)\b)/i;
export function messageBlocked(text: string): boolean {
  return PROFANITY.test(text) || LINK.test(text) || checkInput(text, "banmal") !== null || checkOutput(text, false, text) === "unsafe";
}

/** 목적지 이름만 쓴다. 좌표처럼 보이거나 너무 길면 버린다. */
export function placeName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || [...t].length > 30 || /\d+\.\d{2,}/.test(t) || /[-+]?\d{2,3}\s*[,/]\s*[-+]?\d{2,3}/.test(t) || /https?:/i.test(t)) return null;
  return t;
}

export type DiaryLlm = (system: string, user: string) => Promise<string>;

export type SendResult = { ok: true; message: MessageRow } | { ok: false; reason: "blocked" | "bad_text" | "not_friend" };

const UNDELIVERED_MAX_AGE_MS = 24 * 3600_000;
const REPLAY_MAX = 5;

/** 친구·메시지·도착·운전 끝·일기를 묶는 서비스. 저장소(SocialStore)와 두 가지 푸시 길(차 소켓, 폰 받은편지함)을 쓴다. */
export class Social {
  readonly store: SocialStore;
  readonly inbox = new InboxHub();

  constructor(
    private readonly api: ApiStore,
    db: ConstructorParameters<typeof SocialStore>[0],
    private readonly clock: Clock,
    private readonly talkHub: TalkHub,
    private readonly observer: Observability,
    private readonly diaryLlm: DiaryLlm | null,
  ) {
    this.store = new SocialStore(db, clock, (a) => api.displayNameOf(a));
  }

  /** 텍스트를 검사하고 친구에게 보낸다. toAccount 는 이미 확인된 내 친구의 계정이다. */
  sendToAccount(from: string, toAccount: string, raw: string): SendResult {
    const text = raw.trim();
    if (text.length < 1 || [...text].length > MAX_MESSAGE_CHARS) return { ok: false, reason: "bad_text" };
    if (this.store.friendIdOf(from, toAccount) === null) return { ok: false, reason: "not_friend" };
    if (messageBlocked(text)) {
      this.observer.reject("message.blocked");
      return { ok: false, reason: "blocked" };
    }
    const message = this.store.addMessage(from, toAccount, text);
    this.store.addDiaryEntry(from, "friend_message", `${this.api.displayNameOf(toAccount)}한테 메시지를 보냈어`);
    this.store.addDiaryEntry(toAccount, "friend_message", `${this.api.displayNameOf(from)}한테 메시지를 받았어`);
    this.deliver(message);
    return { ok: true, message };
  }

  private deliver(m: MessageRow): void {
    const fromName = this.api.displayNameOf(m.from);
    const frame = { type: "friend_message", id: m.id, fromName, text: m.text };
    this.inbox.push(m.to, frame);
    const spoken = this.api.talkAllowed(m.to) ? this.talkHub.deliverFriend(m.to, { frame, line: (s: SpeechStyle) => friendSaid(fromName, m.text, s), fromAccount: m.from }) : 0;
    if (spoken > 0) this.store.markDelivered(m.id);
    this.observer.event("friend.message", { spoken });
  }

  /** 차가 연결되면 아직 못 읽어 준 메시지를 한꺼번에 밀어내지 않고 최근 몇 개만 읽어 준다. */
  replayUndelivered(account: string): void {
    for (const m of this.store.undelivered(account, this.clock.now() - UNDELIVERED_MAX_AGE_MS, REPLAY_MAX)) this.deliver(m);
  }

  /** 도착 알림: 보낸 사람이 켜 둔 친구에게만, 목적지 이름만. */
  arrived(account: string, place: string | null): void {
    const fromName = this.api.displayNameOf(account);
    for (const to of this.store.arrivalRecipients(account)) {
      const frame: { type: string; id: string; fromName: string; place?: string } = { type: "friend_arrived", id: crypto.randomUUID(), fromName };
      if (place) frame.place = place;
      this.inbox.push(to, frame);
      this.talkHub.deliverFriend(to, { frame, line: (s: SpeechStyle) => friendArrivedLine(fromName, place, s), fromAccount: account });
    }
  }

  tripStarted(account: string): void {
    this.store.addDiaryEntry(account, "trip_start", "같이 출발했어");
  }

  note(account: string, flag: "rain" | "night"): void {
    this.store.addFlag(account, kstDate(this.clock.now()), flag);
  }

  charged(account: string): void {
    this.store.addDiaryEntry(account, "charging", "충전하면서 쉬었어");
  }

  /** 운전이 끝났다: 폰에 한 줄 보내고 오늘 일기를 다시 쓴다. */
  tripDone(account: string, place: string | null): void {
    const now = this.clock.now();
    const date = kstDate(now);
    const text = tripDoneLine(place);
    this.store.addDiaryEntry(account, "trip_done", text);
    this.inbox.push(account, { type: "trip_done", text, date });
    void this.writeDiary(account, date).catch((e: Error) => this.observer.error("diary.failed", String(e.message).slice(0, 200)));
  }

  async writeDiary(account: string, date: string): Promise<string | null> {
    if (!this.diaryLlm || !this.api.talkAllowed(account)) return null;
    const entries = this.store.diaryEntries(account, date);
    if (entries.length === 0) return null;
    const trips = entries.filter((e) => e.kind === "trip_done");
    const places = this.store.diaryPlaces(account, date);
    const flags = this.store.flags(account, date);
    const facts: string[] = [`오늘 달린 횟수: ${trips.length}번`];
    if (places.length) facts.push(`목적지 이름: ${places.join(", ")}`);
    if (flags.includes("rain")) facts.push("비가 와서 와이퍼를 켰다");
    if (flags.includes("night")) facts.push("어두워서 헤드라이트를 켰다");
    if (entries.some((e) => e.kind === "charging")) facts.push("충전을 하며 쉬었다");
    const msgs = entries.filter((e) => e.kind === "friend_message").length;
    if (msgs) facts.push(`친구와 메시지를 ${msgs}번 주고받았다`);
    const memories = this.api.memoryAllowed(account) ? this.api.listMemory(account, 30).filter((m) => kstDate(Date.parse(m.createdAt)) === date).map((m) => m.text) : [];
    if (memories.length) facts.push(`오늘 운전자가 말해 준 것: ${memories.join(" / ")}`);
    const speech = this.api.getSettings(account).speech;
    const system =
      `너는 "헤이리"다. 운전자와 같이 다닌 하루를 일기로 쓴다. 3~5문장, 문장마다 짧게. ${speech === "jondaetmal" ? "부드러운 존댓말" : "다정한 반말"}로 쓴다. ` +
      "아래 재료에 있는 것만 쓰고 지어내지 않는다. 장소는 이름만 쓰고 좌표·주소·숫자는 쓰지 않는다. 이모지·마크다운·목록 없이 문장만 쓴다.";
    const out = (await this.diaryLlm(system, facts.map((f) => `- ${f}`).join("\n"))).trim();
    const sentences = splitSentences(out).map((s) => s.trim()).filter((s) => s && checkOutput(s, false, "") === "ok" && !/\d+\.\d{3,}/.test(s));
    if (sentences.length === 0) return null;
    const summary = sentences.slice(0, 5).join(" ");
    this.store.setDiarySummary(account, date, summary);
    this.inbox.push(account, { type: "diary_ready", date });
    return summary;
  }
}
