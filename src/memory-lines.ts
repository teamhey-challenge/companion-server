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
export function recentForProactive(items: MemoryItem[], nowMs: number): MemoryItem[] {
  return items
    .filter((m) => {
      const t = Date.parse(m.createdAt);
      return Number.isFinite(t) && nowMs - t <= PROACTIVE_MEMORY_MAX_AGE_DAYS * DAY_MS && t <= nowMs + DAY_MS;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, PROACTIVE_MEMORY_COUNT)
    .map((m) => ({ ...m, text: `${ageLabel(m.createdAt, nowMs)} 말함: ${m.text}` }));
}
