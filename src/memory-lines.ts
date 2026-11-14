import type { MemoryItem } from "../shared/packages/protocol/src/index";
import { kstDay } from "./proactive";

/** 먼저 말 걸기(도착·첫 인사)에 쓸 기억의 최대 나이. 이보다 오래된 기억은 먼저 꺼내지 않는다. */
export const PROACTIVE_MEMORY_MAX_AGE_DAYS = 3;
/** 프롬프트에 담는 기억 수(맨 위 하나가 주인공, 나머지는 곁 맥락). */
export const PROACTIVE_MEMORY_COUNT = 3;

const DAY_MS = 86_400_000;

/** "오늘"·"어제"·"N일 전" 같은 KST 날짜 차이 표현. 날짜 경계는 KST 자정. */
export function ageLabel(createdAtIso: string, nowMs: number): string {
  const then = Date.parse(createdAtIso);
  if (!Number.isFinite(then)) return "예전에";
  const days = Math.round((Date.parse(`${kstDay(nowMs)}T00:00:00Z`) - Date.parse(`${kstDay(then)}T00:00:00Z`)) / DAY_MS);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  return `${days}일 전`;
}

/**
 * 먼저 말 걸기 프롬프트에 넣을 기억: 최근 것만, 새것 먼저, 말한 날을 앞에 붙인다("어제 말함: 오늘 면접 보러 간다").
 * 말한 날을 알아야 모델이 "어제 면접 어땠어?"와 "오늘 면접 잘 보고 와"를 가른다. 없으면 빈 배열(고정 문장을 쓴다).
 */
export function recentForProactive(items: MemoryItem[], nowMs: number, maxAgeDays: number = PROACTIVE_MEMORY_MAX_AGE_DAYS): MemoryItem[] {
  return items
    .filter((m) => {
      const t = Date.parse(m.createdAt);
      return Number.isFinite(t) && nowMs - t <= maxAgeDays * DAY_MS && t <= nowMs + DAY_MS;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, PROACTIVE_MEMORY_COUNT)
    .map((m) => ({ ...m, text: `${ageLabel(m.createdAt, nowMs)} 말함: ${m.text}` }));
}

/** 차 신호(와이퍼·야간 라이트·주행가능거리·문)로 먼저 말 걸 때 쓸 기억의 최대 나이. 취향("비 오는 날 잔잔한 노래")은 면접보다 오래 가서 일주일. */
export const EVENT_MEMORY_MAX_AGE_DAYS = 7;

export type SignalReason = "wiper" | "headlight" | "door" | "range";

/**
 * 신호별 단순 태그. 기억 문장에 태그가 하나라도 있어야 모델에게 후보로 보낸다(관련 없는 기억으로 모델을 부르지 않는다).
 * 최종 관련성 판단(NONE)은 모델이 한다. 태그는 사전 거름망일 뿐이다.
 */
const SIGNAL_TAGS: Record<SignalReason, RegExp> = {
  wiper: /(비|우산|장마|소나기|눈|노래|음악|플레이리스트|라디오|팟캐스트|커피|카페)/,
  headlight: /(야간|밤|퇴근|야근|저녁|늦|노래|음악|플레이리스트|라디오|운동|약속|모임|회식)/,
  door: /(친구|가족|아내|남편|딸|아들|엄마|아빠|부모|동료|애인|여자친구|남자친구|동생|형|누나|오빠|언니|같이|함께|태우|픽업|약속|모임)/,
  range: /(충전|주유|출장|장거리|여행|캠핑|드라이브|이동|약속|모임|본가|고향)/,
};

/** 차 신호에 쓸 기억 후보: 일주일 이내이고 신호 태그가 맞는 것만, 새것 먼저(최대 PROACTIVE_MEMORY_COUNT). */
export function memoriesForSignal(items: MemoryItem[], reason: SignalReason, nowMs: number): MemoryItem[] {
  return recentForProactive(items.filter((m) => SIGNAL_TAGS[reason].test(m.text)), nowMs, EVENT_MEMORY_MAX_AGE_DAYS);
}
