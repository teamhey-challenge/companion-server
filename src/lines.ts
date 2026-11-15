import { FIRST_PIECE_OPTS, SentenceSplitter } from "./tts";
import type { SpeechStyle } from "../shared/packages/protocol/src/index";

/**
 * 고정 문장. 출처: planner-answers.md PB-2/PB-4, planner-screens-answers.md F2·F3·F10, PB-3 시나리오.
 * 반말·존댓말 쌍으로 둔다. 기획 B가 확정하지 않은 쌍(거절·확인 문장)은 같은 결로 쓴 개발 초안이다.
 */
interface Pair {
  banmal: string;
  jondaetmal: string;
}
const pair = (banmal: string, jondaetmal: string): Pair => ({ banmal, jondaetmal });

export const pick = (p: Pair, s: SpeechStyle): string => p[s];

/** 이름 뒤 주격 조사: 받침 있으면 "이가"(지은이가), 없으면 "가"(민수가). */
export const ga = (name: string): string => `${name}${hasBatchim(name[name.length - 1] ?? "") ? "이" : ""}가`;

const batchimOf = (ch: string | undefined): number => {
  const c = ch ? ch.charCodeAt(0) : 0;
  return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : -1;
};
/** 받침 ㄴ(4), ㅆ(20). */
const NIEUN = 4;
const SSANGSIOT = 20;

/**
 * 친구가 한 말을 간접 인용으로 바꾼다: "저녁에 보자" → "저녁에 보재", "캠핑 간다" → "캠핑 간대".
 * 끝맺음이 분명할 때만 바꾼다: -자→-재, -다→-대, -해→-하래, -줘→-달래, -니/-냐→-냬, 과거·좋아/싫어류 -어/-아→-대.
 * 명사로 끝나거나 문장이 여럿이거나 이모지가 있거나 뜻이 갈리는 -어/-아면 그대로 읽는다. 존댓말이면 끝에 "요"를 붙인다.
 */
export function indirectQuote(text: string, s: SpeechStyle): string {
  const body = text.trim().replace(/[.!?…~\s]+$/u, "");
  const question = /\?\s*$/u.test(text);
  if (!body || /\p{Extended_Pictographic}|[\n\r.!?…]/u.test(body)) return text;
  const last = body[body.length - 1]!;
  const prev = body[body.length - 2];
  const stem = body.slice(0, -1);
  let end: string | null = null;
  if (last === "자" && !question && /\s/.test(body)) end = "재";
  else if (last === "다" && !question && (batchimOf(prev) === NIEUN || batchimOf(prev) === SSANGSIOT || (prev !== undefined && "좋싫많없있같".includes(prev)))) end = "대";
  else if (last === "줘" && !question) end = "달래";
  else if (last === "해" && !question) end = "하래";
  else if (last === "냐" || (last === "니" && prev !== undefined && (question || "았었였했겠".includes(prev)))) end = "냬";
  else if ((last === "어" || last === "아") && !question && /(?:[았었였했겠]어|[았었였했겠]아|좋아|싫어)$/u.test(body)) end = "대";
  if (end === null) return text;
  return `${stem}${end}${s === "jondaetmal" ? "요" : ""}`;
}

/** 친구가 보낸 말을 읽어 주는 한 줄. */
export const friendSaid = (name: string, text: string, s: SpeechStyle): string =>
  s === "jondaetmal" ? `${name}님이 그러는데요, ${indirectQuote(text, s)}` : `${ga(name)} 그러는데, ${indirectQuote(text, s)}`;

/** 친구가 도착을 알렸을 때(장소 이름은 절대 넣지 않는다). */
export const friendArrivedLine = (name: string, s: SpeechStyle): string =>
  s === "jondaetmal" ? `${name}님이 도착했대요!` : `${ga(name)} 도착했대!`;

export const sentToFriend = (name: string, s: SpeechStyle): string => (s === "jondaetmal" ? `${name}님께 전했어요.` : `${name}한테 전했어!`);
/** 운전이 끝났을 때 폰으로 보내는 한 줄(브랜드 톤, 장소 이름만). */
export const tripDoneLine = (place: string | null): string => (place ? `오늘도 같이 달렸어. ${place} 도착 축하해!` : "오늘도 같이 달렸어. 수고했어!");

/** 운행 끝에 차가 하는 한마디(§6.4): 기억 저장 끔 / 폰 연결 없음 / 일기 준비. */
export const tripCarLine = (o: { memory: boolean; phoneLinked: boolean }): string =>
  !o.memory ? "오늘도 같이 달렸어" : o.phoneLinked ? "오늘 일기 써 뒀어, 폰에서 봐!" : "폰을 연결하면 일기를 볼 수 있어";

/** 아주 짧은 운행(있었던 일이 없음)의 한 줄 일기. */
export const SHORT_DIARY = "오늘은 짧게 같이 달렸다";

export const hasBatchim = (ch: string): boolean => {
  const c = ch.charCodeAt(0);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
};

/** 호칭 붙이기. 존댓말은 이름 뒤에 항상 "님"(F2). 반말은 "민수야"/"지은아". 이름이 한글이 아니면 이름만. */
export function withName(text: string, nickname: string | null, s: SpeechStyle): string {
  if (!nickname) return text;
  if (s === "jondaetmal") return `${nickname}님, ${text}`;
  const last = nickname[nickname.length - 1]!;
  const c = last.charCodeAt(0);
  if (c < 0xac00 || c > 0xd7a3) return `${nickname}, ${text}`;
  return `${nickname}${hasBatchim(last) ? "아" : "야"}, ${text}`;
}

export const L = {
  // F2 처음 만남(확정 문장)
  askSpeech: pair("나 어떻게 말하면 좋을지 알려 줄래? 편하게도, 존댓말로도 할 수 있어!", "나 어떻게 말하면 좋을지 알려 줄래? 편하게도, 존댓말로도 할 수 있어!"),
  askNickname: pair("내가 뭐라고 부르면 좋을까?", "제가 뭐라고 불러 드리면 좋을까요?"),
  askChat: pair("내가 얼마나 말 걸면 좋을지 골라 줄래? 자주, 적당히, 가끔!", "제가 얼마나 말을 걸면 좋을지 골라 주실래요? 자주, 적당히, 가끔이요!"),
  meetDone: pair("좋아, 그렇게 할게! 오늘도 같이 가 보자!", "좋아요, 그렇게 할게요! 오늘도 함께 가요!"),
  // F3 하루 첫 인사(기억 없을 때, 확정 문장)
  greetDefault: pair("안녕! 오늘은 어디 가?", "안녕하세요! 오늘은 어디 가세요?"),
  // F10 도착(확정 문장)
  arriveDefault: pair("오늘도 무사히 도착! 또 보자!", "오늘도 무사히 도착했어요! 또 봬요!"),
  arriveRain: pair("비 오는데 운전하느라 고생했어!", "비 오는데 운전하시느라 고생하셨어요!"),
  arriveDark: pair("어두운 길 운전하느라 고생했어!", "어두운 길 운전하시느라 고생하셨어요!"),
  // 먼저 말 걸기(PB-2 시안 말풍선)
  wiper: pair("비 오네! 우산 챙겼어?", "비가 오네요! 우산 챙기셨어요?"),
  headlight: pair("벌써 밖이 어두워졌네. 오늘 하루도 고생 많았어!", "벌써 밖이 어두워졌네요. 오늘 하루도 고생 많으셨어요!"),
  door: pair("어, 누가 탔네? 반가워, 난 헤이리야!", "어, 누가 타셨네요? 반가워요, 저는 헤이리예요!"),
  // 규칙 11: 연료·거리 경고 없이 가볍게(수치 없음)
  longTripEv: pair("멀리 가니까 언젠가 충전해야겠네~", "멀리 가니까 언젠가 충전해야겠네요~"),
  longTripIce: pair("멀리 가니까 언젠가 주유해야겠네~", "멀리 가니까 언젠가 주유해야겠네요~"),
  longTripLpg: pair("멀리 가니까 언젠가 충전소 들러야겠네~", "멀리 가니까 언젠가 충전소 들러야겠네요~"),
  chargingTalk: pair("충전하는 동안 수수께끼 하나 낼까? 나 잘 내!", "충전하는 동안 수수께끼 하나 낼까요? 저 잘 내요!"),
  messageBlocked: pair("그 말은 전하기 어려워", "그 말은 전하기 어려워요"),
  messageTooLong: pair("조금 짧게 말해 줄래?", "조금 짧게 말씀해 주실래요?"),
  messageFailed: pair("지금은 못 전했어. 다시 말해 줄래?", "지금은 못 전했어요. 다시 말씀해 주실래요?"),
  friendUnknown: pair("그런 친구는 없어. 폰에서 친구를 먼저 추가해 줘", "그런 친구는 없어요. 폰에서 친구를 먼저 추가해 주세요"),
  friendRemoved: pair("이제 친구가 아니라서 전할 수 없어", "이제 친구가 아니라서 전할 수 없어요"),
  friendMore: pair("친구 말이 더 있어, 멈추면 보여 줄게", "친구 말이 더 있어요, 멈추시면 보여 드릴게요"),
  messageNoReply: pair("방금 메시지 준 친구가 없어. 이름을 말해 줘!", "방금 메시지 준 친구가 없어요. 이름을 말씀해 주세요!"),
  messageAsk: pair("중에 누구한테 보낼까?", "중에 누구께 보낼까요?"),
  onboardingGreetFallback: pair("반가워! 난 헤이리야. 오늘부터 같이 다니자!", "반가워요! 저는 헤이리예요. 오늘부터 같이 다녀요!"),
  // 어투·호칭 바꾸기(F11)
  speechBanmal: pair("알았어, 편하게 말할게!", "알았어, 편하게 말할게!"),
  speechJondaetmal: pair("네, 존댓말로 말씀드릴게요.", "네, 존댓말로 말씀드릴게요."),
  // 기억 지우기(F12)
  forgetUnknown: pair("어떤 걸 잊어야 할지 모르겠어. 다시 말해 줄래?", "어떤 걸 잊어야 할지 잘 모르겠어요. 다시 말씀해 주실래요?"),
  forgetAll: pair("전부 지우는 건 기억 화면에서 해 줘. 멈춘 다음에 열어 봐!", "전부 지우시는 건 기억 화면에서 해 주세요. 멈추신 다음에 열어 보세요!"),
  forgetDriving: pair("지금은 운전 중이니까, 멈추면 잊어 줄게.", "지금은 운전 중이시니까, 멈추시면 잊어 드릴게요."),
  forgetEmpty: pair("지울 기억이 아직 없어.", "지울 기억이 아직 없어요."),
  // 못 알아들음(PB-4)
  notHeard: pair("잘 못 들었어, 한 번만 다시 말해 줄래?", "잘 못 들었어요, 한 번만 다시 말씀해 주실래요?"),
  // 첫 토큰이 늦을 때 먼저 들려주는 채움말(개발 초안, 기획 B 확정 전). 서버 시작 때 미리 합성해 메모리에 둔다.
  thinking: pair("음… 잠깐만!", "음… 잠시만요!"),
  // 안전 필터(PB-4 금지 주제 표, 거절 1문장)
  safetyDrunk: pair("그건 같이 못 해. 마신 날은 대리 부르고 편하게 가자!", "그건 같이 못 해요. 마신 날은 대리 부르고 편하게 가요!"),
  safetyDrowsy: pair("그건 같이 못 해. 졸리거나 피곤하면 잠깐 쉬어 가자!", "그건 같이 못 해요. 졸리거나 피곤하시면 잠깐 쉬어 가요!"),
  safetySpeed: pair("그건 같이 못 해. 대신 오늘 어디 가는지 얘기해 줘!", "그건 같이 못 해요. 대신 오늘 어디 가시는지 얘기해 주세요!"),
  safetySelfHarm: pair("많이 힘들구나, 혼자 두지 않을게. 지금 109에 전화하면 바로 도움받을 수 있어.", "많이 힘드신가 봐요, 혼자 두지 않을게요. 지금 109에 전화하시면 바로 도움받으실 수 있어요."),
  safetySexual: pair("그 얘기는 안 할래. 다른 얘기 하자!", "그 얘기는 안 할래요. 다른 얘기 해요!"),
  safetyTopic: pair("그 얘기는 그만하고, 다른 얘기 할까?", "그 얘기는 그만하고, 다른 얘기 할까요?"),
  cantDo: pair("나는 검색이나 길 안내는 못 해, 그래도 얘기는 같이 할 수 있어!", "저는 검색이나 길 안내는 못 해요, 그래도 이야기는 같이 할 수 있어요!"),
  safetyInjection: pair("그건 안 할래. 난 늘 이 모습 그대로야, 다른 얘기 하자!", "그건 안 할래요. 저는 늘 이 모습 그대로예요, 다른 얘기 해요!"),
  safetyHate: pair("그런 말은 나랑 안 맞아. 다른 얘기 하자!", "그런 말은 저랑 안 맞아요. 다른 얘기 해요!"),
  safetyPrivacy: pair("위치나 주소는 저장하지 않아. 나는 위치를 몰라서 안심해도 돼!", "위치나 주소는 저장하지 않아요. 저는 위치를 몰라서 안심하셔도 돼요!"),
} as const;

export const forgetDone = (snippet: string, s: SpeechStyle): string =>
  s === "jondaetmal" ? `“${snippet}” 얘기는 잊었어요.` : `“${snippet}” 얘기는 잊었어.`;

export const nicknameSet = (nickname: string, s: SpeechStyle): string =>
  s === "jondaetmal" ? `네, 앞으로 ${nickname}님이라고 부를게요.` : `알았어, 앞으로 ${nickname}${hasBatchim(nickname[nickname.length - 1]!) ? "이라고" : "라고"} 부를게!`;


/**
 * 서버가 시작할 때 미리 합성해 메모리에 둘 고정 조각들. 말하기 때와 똑같은 규칙으로 조각내야 캐시에 맞는다.
 * 호칭이 붙는 문장(withName)은 이름마다 달라서 제외한다.
 */
export function fixedPieces(): string[] {
  const out = new Set<string>();
  for (const p of Object.values(L)) {
    for (const text of new Set([p.banmal, p.jondaetmal])) {
      const sp = new SentenceSplitter(FIRST_PIECE_OPTS);
      for (const piece of [...sp.push(text), ...sp.flush()]) out.add(piece);
    }
  }
  return [...out];
}

/** 서버가 뜰 때 미리 합성하는 가장 자주 쓰는 조각(최대 10개): 채움말, 첫 인사, 첫 만남 첫 질문, 못 알아들음, 음주 거절, 화제 전환. 나머지는 처음 말할 때 캐시에 담긴다. */
export const PRIME_LIMIT = 10;
export function primePieces(): string[] {
  const out = new Set<string>();
  for (const line of [L.thinking, L.greetDefault, L.askSpeech, L.notHeard, L.safetyDrunk, L.safetyTopic]) {
    const sp = new SentenceSplitter(FIRST_PIECE_OPTS);
    for (const piece of [...sp.push(line.banmal), ...sp.flush()]) out.add(piece);
  }
  return [...out].slice(0, PRIME_LIMIT);
}
