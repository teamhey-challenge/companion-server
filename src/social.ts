import type { SpeechStyle } from "../shared/packages/protocol/src/index";
import type { ApiStore } from "./api-store";
import type { Clock } from "./clock";
import { SHORT_DIARY, friendArrivedLine, friendSaid, tripCarLine, tripDoneLine } from "./lines";
import type { Observability } from "./observe";
import { checkInput, checkOutput } from "./safety";
import { MAX_MESSAGE_CHARS, SocialStore, kstDate, type DiaryKind, type MessageRow } from "./social-store";
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

export type SendResult = { ok: true; message: MessageRow } | { ok: false; reason: "blocked" | "bad_text" | "too_long" | "not_friend" };

const UNDELIVERED_MAX_AGE_MS = 24 * 3600_000;
const REPLAY_MAX = 50;

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
    if (text.length < 1) return { ok: false, reason: "bad_text" };
    if ([...text].length > MAX_MESSAGE_CHARS) return { ok: false, reason: "too_long" };
    if (this.store.friendIdOf(from, toAccount) === null) return { ok: false, reason: "not_friend" };
    if (messageBlocked(text)) {
      this.observer.reject("message.blocked");
      return { ok: false, reason: "blocked" };
    }
    const message = this.store.addMessage(from, toAccount, text);
    this.diary(from, "friend_message", `${this.api.displayNameOf(toAccount)}한테 메시지를 보냈어`);
    this.diary(toAccount, "friend_message", `${this.api.displayNameOf(from)}한테 메시지를 받았어`);
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

  /** 친구 요청 알림: 앱 안 표시만(시스템 알림·음성 없음). 차 소켓과 폰 받은편지함에 같은 프레임. */
  notifyFriend(account: string, frame: { type: "friend_request"; id: string; fromName: string } | { type: "friend_accepted"; id: string; name: string }): void {
    this.inbox.push(account, frame);
    this.talkHub.pushCar(account, frame);
  }

  /** 차가 연결되면 아직 못 읽어 준 메시지를 한꺼번에 밀어내지 않고 최근 몇 개만 읽어 준다. */
  replayUndelivered(account: string): void {
    for (const m of this.store.undelivered(account, this.clock.now() - UNDELIVERED_MAX_AGE_MS, REPLAY_MAX)) this.deliver(m);
  }

  /** 도착 알림: 보낸 사람이 켜 둔 친구에게만. "도착했대"만 보내고 장소·목적지 이름은 보내지 않는다. */
  arrived(account: string): void {
    const fromName = this.api.displayNameOf(account);
    for (const to of this.store.arrivalRecipients(account)) {
      const frame = { type: "friend_arrived", id: crypto.randomUUID(), fromName };
      this.inbox.push(to, frame);
      this.talkHub.deliverFriend(to, { frame, line: (s: SpeechStyle) => friendArrivedLine(fromName, s), fromAccount: account });
    }
  }

  /** 기억 저장이 꺼져 있으면(동의 없음·설정 끔) 일기에 아무것도 남기지 않는다. */
  private diary(account: string, kind: DiaryKind, text: string, date?: string): void {
    if (this.api.memoryAllowed(account)) this.store.addDiaryEntry(account, kind, text, date);
  }

  place(account: string, date: string, place: string): void {
    if (this.api.memoryAllowed(account)) this.store.addPlace(account, date, place);
  }

  tripStarted(account: string, date?: string): void {
    this.diary(account, "trip_start", "같이 출발했어", date);
  }

  note(account: string, flag: "rain" | "night", date?: string): void {
    if (this.api.memoryAllowed(account)) this.store.addFlag(account, date ?? kstDate(this.clock.now()), flag);
  }

  charged(account: string, date?: string): void {
    this.diary(account, "charging", "충전하면서 쉬었어", date);
  }

  /**
   * 운전이 끝났다(§6.4). date 는 운행을 시작한 날(자정을 넘겨도 그날의 일기에 넣는다).
   * 폰에는 "오늘도 같이 달렸어" 한 줄을 보내고, 차에는 연결 상태에 맞는 한마디(carLine)를 보낸다.
   * 일기를 쓰지 못하면 폰에 "일기 준비됨"을 보내지 않고, 다음 운행 끝에 다시 쓴다.
   */
  tripDone(account: string, place: string | null, date: string = kstDate(this.clock.now())): void {
    const now = this.clock.now();
    const text = tripDoneLine(place);
    this.diary(account, "trip_done", text, date);
    const memory = this.api.memoryAllowed(account);
    const phoneLinked = this.api.phoneLinked(account);
    const frame = { type: "trip_done", id: crypto.randomUUID(), text, date, at: new Date(now).toISOString(), carLine: tripCarLine({ memory, phoneLinked }), phoneLinked };
    this.inbox.push(account, frame);
    if (this.api.talkAllowed(account)) this.talkHub.pushCar(account, frame);
    const dates = new Set<string>([date, ...this.store.pendingDiaryDates(account)]);
    for (const d of dates) void this.writeDiary(account, d).catch((e: Error) => this.observer.error("diary.failed", String(e.message).slice(0, 200)));
  }

  async writeDiary(account: string, date: string): Promise<string | null> {
    if (!this.api.talkAllowed(account) || !this.api.memoryAllowed(account)) return null;
    const entries = this.store.diaryEntries(account, date);
    if (entries.length === 0) return null;
    const trips = entries.filter((e) => e.kind === "trip_done");
    const places = this.store.diaryPlaces(account, date);
    const flags = this.store.flags(account, date);
    const msgs = entries.filter((e) => e.kind === "friend_message").length;
    const charged = entries.some((e) => e.kind === "charging");
    const memories = this.api.listMemory(account, 30).filter((m) => kstDate(Date.parse(m.createdAt)) === date).map((m) => m.text);
    // 재료가 하나도 없는 아주 짧은 운행은 모델 없이 한 줄만 쓴다.
    if (places.length === 0 && flags.length === 0 && !charged && msgs === 0 && memories.length === 0) {
      this.store.clearDiaryPending(account, date);
      return this.finishDiary(account, date, SHORT_DIARY);
    }
    if (!this.diaryLlm) return null;
    const facts: string[] = [`오늘 달린 횟수: ${trips.length}번`];
    if (places.length) facts.push(`목적지 이름: ${places.join(", ")}`);
    if (flags.includes("rain")) facts.push("비가 와서 와이퍼를 켰다");
    if (flags.includes("night")) facts.push("어두워서 헤드라이트를 켰다");
    if (charged) facts.push("충전을 하며 쉬었다");
    if (msgs) facts.push(`친구와 메시지를 ${msgs}번 주고받았다`);
    if (memories.length) facts.push(`오늘 운전자가 말해 준 것: ${memories.join(" / ")}`);
    const system =
      '너는 "헤이리"다. 운전자와 같이 다닌 하루를 1인칭으로 일기에 쓴다. 3~5문장, 문장마다 짧게, "~했다/~였다/~해야지" 같은 일기 반말로 쓴다. ' +
      "아래 재료에 있는 것만 쓰고 지어내지 않는다. 장소는 이름만 쓰고 좌표·주소·숫자는 쓰지 않는다. 이모지·마크다운·목록 없이 문장만 쓴다.";
    let out: string;
    try {
      out = (await this.diaryLlm(system, facts.map((f) => `- ${f}`).join("\n"))).trim();
    } catch (e) {
      this.store.markDiaryPending(account, date);
      throw e;
    }
    // LLM 을 기다리는 사이 동의가 철회됐을 수 있다.
    if (!this.api.talkAllowed(account) || !this.api.memoryAllowed(account)) return null;
    const sentences = splitSentences(out).map((s) => s.trim()).filter((s) => s && checkOutput(s, false, "") === "ok" && !/\d+\.\d{3,}/.test(s));
    if (sentences.length === 0) {
      this.store.markDiaryPending(account, date);
      return null;
    }
    this.store.clearDiaryPending(account, date);
    return this.finishDiary(account, date, sentences.slice(0, 5).join(" "));
  }

  private finishDiary(account: string, date: string, summary: string): string {
    this.store.setDiarySummary(account, date, summary);
    this.inbox.push(account, { type: "diary_ready", date });
    return summary;
  }
}
