import { FIRST_PIECE_OPTS, SentenceSplitter } from "./tts";
import type { SpeechStyle } from "../shared/packages/protocol/src/index";
import { MAX_TEXT_CHARS } from "../shared/packages/protocol/src/index";
import { answerNickname } from "./intents";
import { messageBlocked } from "./social";

/**
 * 온보딩: 고래가 세계관·질문을 하고(고래 목소리), 헤이리가 첫 인사·기억·꾸미기·QR·마무리를 말한다(헤이리 목소리).
 * 프레임은 /v1/talk 위에서 오간다(companion-shared 에 아직 없는 타입이라 talk.ts 가 parseClientFrame 앞에서 걸러 낸다).
 *  앱→서버 {type:"onboarding", step}          그 단계를 지금 말해 줘
 *  앱→서버 {type:"onboarding.answer", step, text, reply?}   q1~q3 의 말로 한 답(STT 문장). reply:true 면 서버가 고래 맞장구(못 알아들었으면 skip 대사)까지 말한다
 *  서버→앱 {type:"onboarding", step, id, text?}  이어서 reply.start/PCM/reply.end(turnId=id). greeting 은 text 가 reply.end 에 온다
 *  서버→앱 {type:"onboarding.ack", step, ok, name?, skipped?} 답을 받았다. ok:false 면 skipped:true(reply:true 일 때) — 다시 묻지 말고 다음 단계로 간다
 *  서버→앱 {type:"onboarding", step:"ack", for:"q1"|"q2"|"q3", id, text}  reply:true 답이 받아들여진 뒤 고래 맞장구(LLM, 2.5초 안에 못 만들면 고정 문장). 이어서 reply.* 프레임
 *  서버→앱 {type:"onboarding", step:"skip", id, text}  reply:true 답을 못 알아들었을 때(onboarding.ack ok:false 직후), 이어서 reply.*
 *
 * 동의 없이 말할 수 있는 단계는 CONSENT_FREE_STEPS 뿐이다(고정 대사: 사용자 데이터가 LLM·외부로 가지 않는다). 기획 순서가 고래 소개를 동의 시트보다 앞에 두기 때문이다.
 * 질문(q1~q3)·답·첫 인사·맞장구는 record + external_ai 동의가 있어야 한다(AC-4.9-05).
 */
export const ONBOARDING_STEPS = ["whale_intro", "lights", "q1", "q2", "q3", "skip", "found", "greeting", "memory", "dress", "qr", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type QuestionStep = "q1" | "q2" | "q3";
export type WhaleStep = "whale_intro" | "lights" | QuestionStep | "skip" | "found";
export type HeyriFixedStep = "memory" | "dress" | "qr" | "done";

/** 동의 전에도 말할 수 있는 단계. 고정 문장뿐이고 운전자 말·기억·차량 정보가 섞이지 않는다. */
export const CONSENT_FREE_STEPS: Partial<Record<OnboardingStep, true>> = { whale_intro: true, lights: true, skip: true, found: true, memory: true, dress: true, qr: true, done: true };

/** 고래는 이름이 없다(기획 결정 2026-11-15 17:57): 대사에 이름을 넣지 않는다. 고래 대사 문장은 시안(Onboarding.tsx `L`·`QUESTIONS`)과 같다. */
/** 고래 대사. 기획 시안(Onboarding.tsx `L`·`QUESTIONS`)과 같은 문장이다. */
export const WHALE_LINES: Record<WhaleStep, string> = {
  whale_intro: "안녕, 나는 빛바다를 지키는 고래야. 여기 헤이리들은 길을 함께 달릴 사람 단짝을 찾고 있어. 너랑 꼭 맞는 헤이리를 찾아 줄게.",
  lights: "여기 빛 하나하나가 너의 헤이리가 될 수 있어. 이제 너에 대해 알려 줘.",
  q1: "먼저, 뭐라고 불러 줄까?",
  q2: "이 차로 주로 어디 다녀?",
  q3: "차 안에서는 어떤 얘기가 좋아?",
  skip: "괜찮아, 다음에 알려 줘.",
  found: "찾았다. 너랑 꼭 맞는 헤이리야. 길게 눌러서 만나 봐.",
};

type Pair = Record<SpeechStyle, string>;
/** 헤이리 고정 대사(시안 L). memoryOff 는 기억 저장이 꺼져 있을 때 memory 대신 쓴다: 기억해 두겠다고 말하지 않는다. */
export const HEYRI_LINES: Record<"memory" | "memoryOff" | "dress" | "qr" | "done", Pair> = {
  memory: { banmal: "너에 대해 이만큼 알게 됐어. 이건 기억해 둘게, 언제든 지울 수 있어.", jondaetmal: "당신에 대해 이만큼 알게 됐어요. 이건 기억해 둘게요, 언제든 지울 수 있어요." },
  memoryOff: { banmal: "너에 대해 이만큼 알게 됐어. 기억 저장을 켜면 이렇게 기억해 둘게.", jondaetmal: "당신에 대해 이만큼 알게 됐어요. 기억 저장을 켜면 이렇게 기억해 둘게요." },
  dress: { banmal: "나 어떤 모습이 좋아? 골라 줘.", jondaetmal: "저는 어떤 모습이 좋아요? 골라 주세요." },
  qr: { banmal: "폰에서도 나랑 얘기하고 싶으면 이걸 찍어 줘. 나중에 해도 돼.", jondaetmal: "폰에서도 저랑 얘기하고 싶으시면 이걸 찍어 주세요. 나중에 하셔도 돼요." },
  done: { banmal: "좋아, 이제 같이 가자!", jondaetmal: "좋아요, 이제 같이 가요!" },
};

/** 맞장구 LLM 이 이 시간 안에 첫 글자를 못 내면 고정 문장으로 대신한다. */
export const ACK_LLM_FIRST_MS = 2500;
export function ackFallback(step: QuestionStep, name?: string | null): string {
  if (step === "q1") return name ? `${name}, 반가워.` : "그래, 알겠어.";
  return step === "q2" ? "그렇구나. 같이 다니자." : "좋아, 그 얘기 많이 하자.";
}

/** 맞장구 LLM 지시(고래 말투, 20자 안팎 한 문장). 운전자가 말한 것만 쓴다. */
export function ackInstruction(step: QuestionStep, answer: string): string {
  const what = step === "q1" ? "불러 줬으면 하는 이름" : step === "q2" ? "이 차로 주로 다니는 곳" : "차 안에서 듣고 싶은 이야기";
  return `너는 빛바다를 지키는 고래 안내자다. 운전자가 ${what}을(를) 이렇게 말했다: "${answer}". 이를 받아 20자 안팎의 짧은 반말 한 문장으로 맞장구만 친다. 질문은 하지 않고, 말하지 않은 건 지어내지 않는다. "NONE"은 쓰지 않는다.`;
}

/** 고정 대사를 TTS 조각으로 잘라 돌려준다(말할 때의 조각과 같아야 캐시가 맞는다). 캐시는 서버 메모리뿐이다. */
export function onboardingPieces(): string[] {
  const out = new Set<string>();
  for (const text of [...Object.values(WHALE_LINES), ...Object.values(HEYRI_LINES).flatMap((p) => [p.banmal, p.jondaetmal])]) {
    const sp = new SentenceSplitter(FIRST_PIECE_OPTS);
    for (const piece of [...sp.push(text), ...sp.flush()]) out.add(piece);
  }
  return [...out];
}

export type OnboardingFrame = { kind: "step"; step: OnboardingStep } | { kind: "answer"; step: QuestionStep; text: string; reply: boolean };

const isStep = (v: unknown): v is OnboardingStep => typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);
const isQuestion = (v: unknown): v is QuestionStep => v === "q1" || v === "q2" || v === "q3";

/** 온보딩 프레임이면 검증해서 돌려주고, 아니면 null(일반 프레임 검증으로 넘어간다). */
export function parseOnboardingFrame(raw: string): OnboardingFrame | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null || !("type" in m) || !("step" in m)) return null;
  if (m.type === "onboarding" && isStep(m.step)) return { kind: "step", step: m.step };
  if (m.type === "onboarding.answer" && isQuestion(m.step) && "text" in m && typeof m.text === "string" && m.text.length <= MAX_TEXT_CHARS) {
    return { kind: "answer", step: m.step, text: m.text, reply: "reply" in m && m.reply === true };
  }
  return null;
}

/** q1 답에서 이름. string = 이름, null = 이름 없이 넘어감(됐어·싫어), undefined = 다시 물어야 함(알아듣지 못함·안전 필터에 걸림). */
export function parseOnboardingName(text: string): string | null | undefined {
  const name = answerNickname(text);
  if (name === undefined) return undefined;
  if (name !== null && messageBlocked(name)) return undefined;
  return name;
}

const MAX_ANSWER_CHARS = 40;

/** q2·q3 답을 기억 한 줄로 쓸 수 있게 다듬는다. 비었거나 안전 필터·전화번호·좌표에 걸리면 null. */
export function cleanOnboardingAnswer(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim().replace(/[.!?。~…\s]+$/u, "");
  if (!t || messageBlocked(t)) return null;
  if ((t.match(/\d/g)?.length ?? 0) >= 6 || /\d+\.\d{2,}/.test(t)) return null;
  return [...t].slice(0, MAX_ANSWER_CHARS).join("");
}

export interface OnboardingAnswers {
  name?: string | null;
  trips?: string;
  topics?: string;
}

export const tripsMemory = (t: string): string => `주로 다니는 곳: ${t}`;
export const topicsMemory = (t: string): string => `차에서 듣고 싶은 이야기: ${t}`;

/** 첫 인사 LLM 지시: 운전자가 말한 내용을 짧게 녹이고, 말하지 않은 것은 지어내지 않는다. */
export function greetingInstruction(a: OnboardingAnswers): string {
  const said: string[] = [];
  if (a.name) said.push(`이름은 ${a.name}`);
  if (a.trips) said.push(`이 차로 주로 다니는 곳은 "${a.trips}"`);
  if (a.topics) said.push(`차 안에서 듣고 싶은 이야기는 "${a.topics}"`);
  return (
    "고래의 소개로 운전자를 처음 만나 인사한다. 운전자가 고래에게 말한 것: " +
    (said.length ? said.join(", ") : "(말한 것 없음)") +
    '. 이 중 말한 것을 한두 가지만 자연스럽게 녹여 반갑게 인사하고, 마지막은 가볍게 이어 갈 질문 하나로 끝낸다. 전체 2문장 이내. 말하지 않은 건 지어내지 않고, 장소는 말한 이름 그대로만 쓴다. "정확히 NONE"은 쓰지 않는다.'
  );
}
