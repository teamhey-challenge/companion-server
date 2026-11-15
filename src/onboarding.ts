import { MAX_TEXT_CHARS } from "../shared/packages/protocol/src/index";
import { answerNickname } from "./intents";
import { messageBlocked } from "./social";

/**
 * 온보딩(D-48): 고래가 세계관 한 줄과 세 질문을 하고(고래 목소리), 마지막에 헤이리가 답을 넣어 첫 인사를 한다.
 * 프레임은 /v1/talk 위에서 오간다(companion-shared 에 아직 없는 타입이라 talk.ts 가 parseClientFrame 앞에서 걸러 낸다).
 *  앱→서버 {type:"onboarding", step}          그 단계를 지금 말해 줘
 *  앱→서버 {type:"onboarding.answer", step, text}   q1~q3 의 말로 한 답(STT 문장)
 *  서버→앱 {type:"onboarding", step, id, text?}  이어서 reply.start/PCM/reply.end(turnId=id). greeting 은 text 가 reply.end 에 온다
 *  서버→앱 {type:"onboarding.ack", step, ok, name?} 답을 받았다. ok:false 면 다시 물어본다
 */
export const ONBOARDING_STEPS = ["whale_intro", "q1", "q2", "q3", "greeting"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type QuestionStep = "q1" | "q2" | "q3";

/** 고래 대사. 질문은 기획 초안 그대로이고, 세계관 한 줄은 기획 A 문구가 정해지면 여기만 바꾼다. 헤이리 고정 문장과 달리 미리 합성하지 않는다. */
export const WHALE_LINES: Record<Exclude<OnboardingStep, "greeting">, string> = {
  whale_intro: "안녕, 나는 이 차 곁을 헤엄치는 고래야. 오늘부터 너랑 같이 다닐 친구 헤이리를 소개해 줄게!",
  q1: "뭐라고 불러 줄까?",
  q2: "이 차로 주로 어디 다녀?",
  q3: "차 안에서 어떤 얘기가 좋아?",
};

export type OnboardingFrame = { kind: "step"; step: OnboardingStep } | { kind: "answer"; step: QuestionStep; text: string };

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
    return { kind: "answer", step: m.step, text: m.text };
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
