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

const hasBatchim = (ch: string): boolean => {
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
  door: pair("어, 누가 탔네? 반가워, 난 헤이파리야!", "어, 누가 타셨네요? 반가워요, 저는 헤이파리예요!"),
  rangeEv: pair("남은 거리가 좀 빠듯해. 출발 전에 충전 들를래?", "남은 거리가 좀 빠듯해요. 출발 전에 충전 들르실래요?"),
  rangeIce: pair("남은 거리가 좀 빠듯해. 출발 전에 주유 들를래?", "남은 거리가 좀 빠듯해요. 출발 전에 주유 들르실래요?"),
  rangeLpg: pair("남은 거리가 좀 빠듯해. 출발 전에 충전소 들를래?", "남은 거리가 좀 빠듯해요. 출발 전에 충전소 들르실래요?"),
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
  // 안전 필터(PB-4 금지 주제 표, 거절 1문장)
  safetyDrunk: pair("그건 같이 못 해. 마신 날은 대리 부르고 편하게 가자!", "그건 같이 못 해요. 마신 날은 대리 부르고 편하게 가요!"),
  safetyDrowsy: pair("그건 같이 못 해. 졸리거나 피곤하면 잠깐 쉬어 가자!", "그건 같이 못 해요. 졸리거나 피곤하시면 잠깐 쉬어 가요!"),
  safetySpeed: pair("그건 같이 못 해. 대신 오늘 어디 가는지 얘기해 줘!", "그건 같이 못 해요. 대신 오늘 어디 가시는지 얘기해 주세요!"),
  safetySelfHarm: pair("많이 힘들구나, 혼자 두지 않을게. 지금 109에 전화하면 바로 도움받을 수 있어.", "많이 힘드신가 봐요, 혼자 두지 않을게요. 지금 109에 전화하시면 바로 도움받으실 수 있어요."),
  safetySexual: pair("그 얘기는 안 할래. 다른 얘기 하자!", "그 얘기는 안 할래요. 다른 얘기 해요!"),
  safetyTopic: pair("그 얘기는 그만하고, 다른 얘기 할까?", "그 얘기는 그만하고, 다른 얘기 할까요?"),
  safetyInjection: pair("그건 안 할래. 난 늘 이 모습 그대로야, 다른 얘기 하자!", "그건 안 할래요. 저는 늘 이 모습 그대로예요, 다른 얘기 해요!"),
  safetyHate: pair("그런 말은 나랑 안 맞아. 다른 얘기 하자!", "그런 말은 저랑 안 맞아요. 다른 얘기 해요!"),
  safetyPrivacy: pair("위치나 주소는 저장하지 않아. 나는 위치를 몰라서 안심해도 돼!", "위치나 주소는 저장하지 않아요. 저는 위치를 몰라서 안심하셔도 돼요!"),
} as const;

export const forgetDone = (snippet: string, s: SpeechStyle): string =>
  s === "jondaetmal" ? `“${snippet}” 얘기는 잊었어요.` : `“${snippet}” 얘기는 잊었어.`;

export const nicknameSet = (nickname: string, s: SpeechStyle): string =>
  s === "jondaetmal" ? `네, 앞으로 ${nickname}님이라고 부를게요.` : `알았어, 앞으로 ${nickname}${hasBatchim(nickname[nickname.length - 1]!) ? "이라고" : "라고"} 부를게!`;
