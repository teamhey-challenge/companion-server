import { PROACTIVE_INTERVAL_MIN, type Ctx, type ProactiveLevel } from "../shared/packages/protocol/src/index";

/**
 * 먼저 말 걸기 결정(PRD §7.1, §7.7, D-14, D-28). 차 앱이 보낸 ctx 두 장(이전·지금)을 비교해 서버가 정한다.
 * 규칙은 순수 함수로 두고, 소켓·타이머·말하기는 talk.ts가 한다.
 */

export type EventReason = "wiper" | "longTrip" | "headlight" | "door" | "charging";
export type Reason = EventReason | "meet" | "greeting" | "arrival";

/** 같은 이유로 다시 말하기까지 최소 시간(와이퍼가 깜빡여도 반복하지 않게). 같은 주행에서는 아예 한 번만. */
export const COOLDOWN_MS = 5 * 60_000;
/** 내비 목적지까지 남은 거리가 이 값(km) 이상이면 "멀리 가는 길"이라 수치·경고 없이 가볍게 한마디 한다(D-47 규칙 11). */
export const LONG_TRIP_KM = 100;
/** 기어 P로 바뀐 뒤 도착 인사까지(F10). */
export const ARRIVAL_DELAY_MS = 3000;
/** 기억을 꺼내는 먼저 말 걸기는 주행(탑승)당 최대 2회. */
export const MAX_MEMORY_RECALLS = 2;

export interface ProState {
  /** 지난 스냅샷 */
  prev: Ctx | null;
  /** 이벤트성 먼저 말(와이퍼·거리·라이트·도어)을 마지막으로 한 시각 */
  lastEventAt: number | null;
  reasonAt: Partial<Record<Reason, number>>;
  /** 이번 주행(탑승)에 이미 말한 이유 */
  fired: Set<Reason>;
  memoryRecalls: number;
  /** 오늘 주행 중 실제로 있었던 일(도착 인사 ②) */
  dayEvents: Set<"rain" | "dark">;
  drove: boolean;
  greetChecked: boolean;
}

export const newProState = (): ProState => ({
  prev: null, lastEventAt: null, reasonAt: {}, fired: new Set(), memoryRecalls: 0, dayEvents: new Set(), drove: false, greetChecked: false,
});

/** 설정 단계 → 최소 간격(ms). 꺼짐이면 null. */
export function intervalMs(level: ProactiveLevel): number | null {
  return level === "off" ? null : PROACTIVE_INTERVAL_MIN[level] * 60_000;
}

export const wiperOn = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0 && !/^(off|0|false|none)$/i.test(String(v));

/** 한국 시각(KST) 시. 시험과 서버가 같은 시계를 쓴다. */
export const kstHour = (nowMs: number): number => new Date(nowMs + 9 * 3_600_000).getUTCHours();
export const kstDay = (nowMs: number): string => new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
export const isNight = (nowMs: number): boolean => {
  const h = kstHour(nowMs);
  return h >= 17 || h < 5;
};

/** VHAL FuelType 숫자(10=전기, 7=LPG, 8=CNG, 9=LNG, 11=수소)나 문자열을 세 갈래로 접는다. */
export function fuelKind(v: unknown): "ev" | "lpg" | "ice" {
  const s = String(v ?? "").toLowerCase();
  if (s === "10" || /elec|ev|전기/.test(s)) return "ev";
  if (s === "7" || /lpg|lng|cng|가스/.test(s) || s === "8" || s === "9") return "lpg";
  return "ice";
}

/** 멀리 가는 길인가: 기어 P 에서 내비 목적지까지 남은 거리가 LONG_TRIP_KM 이상. */
export function longTrip(c: Ctx): boolean {
  return c.gear === "P" && typeof c.destKm === "number" && c.destKm >= LONG_TRIP_KM;
}

/** 지난 ctx와 지금 ctx 사이에 새로 생긴 이벤트들(우선순위 순). 첫 스냅샷(prev 없음)은 기준선이라 이벤트가 없다. */
export function detectEvents(prev: Ctx | null, cur: Ctx, nowMs: number): EventReason[] {
  if (!prev) return [];
  const out: EventReason[] = [];
  if (!wiperOn(prev.wiper) && wiperOn(cur.wiper)) out.push("wiper");
  if (longTrip(cur) && !longTrip(prev)) out.push("longTrip");
  if (prev.charging !== true && cur.charging === true) out.push("charging");
  if (prev.headlight === false && cur.headlight === true && isNight(nowMs)) out.push("headlight");
  if (cur.gear === "P" && prev.doorOpen === false && cur.doorOpen === true) out.push("door");
  return out;
}

/** 이벤트를 지금 말해도 되는가(내비 중, 끄기, 간격, 같은 주행 1회, 이유별 쿨다운). */
export function eventAllowed(reason: EventReason, level: ProactiveLevel, cur: Ctx, st: ProState, nowMs: number): boolean {
  const gap = intervalMs(level);
  if (gap === null) return false;
  // D-14: 내비 안내 중엔 새로 말 걸지 않는다. 단 시나리오 2(정차 P 에서 목적지와 주행가능거리 비교)는 안내 음성이 없는 정차 중이라 예외다.
  if (cur.naviGuiding === true && !(reason === "longTrip" && longTrip(cur) && !(typeof cur.speedKmh === "number" && cur.speedKmh > 0))) return false;
  if (st.fired.has(reason)) return false;
  if (st.lastEventAt !== null && nowMs - st.lastEventAt < gap) return false;
  const last = st.reasonAt[reason];
  if (last !== undefined && nowMs - last < COOLDOWN_MS) return false;
  return true;
}
