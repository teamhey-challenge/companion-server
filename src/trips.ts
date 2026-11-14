import { REGIONS, SIDO_LIST, findRegion, type Region } from "./regions";

/**
 * 함께 다닌 길(프로토타입). 한 번의 주행 = 기어 D → P. 좌표는 어디에도 없다.
 * 배지·열린 동네는 저장하지 않고 trips(와 기억 개수)에서 매번 계산한다. 그래서 길을 지우면 배지도 같이 사라진다.
 * 세는 단위는 날·처음 가 본 동네·같은 곳 방문뿐이다. 속도·급제동·분당 거리·주행 시간·누적 거리는 어느 배지에도 쓰지 않는다
 * (docs/status/2026-11-15-concept-mz.md §4: 더 타게 만드는 보상 금지, 완성도·진행률 표시 금지).
 */
export interface TripRow {
  id: string;
  startedAt: number;
  endedAt: number;
  distanceKm: number | null;
  destination: string | null;
  sido: string | null;
  sigungu: string | null;
  /** 시·군·구 값이 차가 준 것이 아니라 데모 설정·시드에서 온 것. */
  regionDemo: boolean;
  /** 이 길이 끝난 뒤 주차 중에 나눈 사용자 말 수. */
  parkedTurns: number;
}

export interface TripView {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  distanceKm: number | null;
  destination: string | null;
  region: string | null;
}

/** 얻은 배지만 진짜 이름·설명을 보여 주고, 못 얻은 배지는 이름만 흐리게(진행률·남은 수 없음). */
export interface BadgeView {
  id: string;
  title: string;
  description: string;
  playful: boolean;
  earned: boolean;
  earnedAt: string | null;
}

export interface RegionGroup {
  sido: string;
  unlocked: { name: string; firstAt: string; trips: number; demo: boolean }[];
}

export interface TripsResponse {
  enabled: boolean;
  tone: Tone;
  stats: { tripCount: number; totalKm: number | null; regionCount: number; sidoCount: number; badgeCount: number };
  trips: TripView[];
  badges: BadgeView[];
  /** 가 본 시·도만. 안 가 본 곳은 보내지 않는다(완성도 표시 금지). */
  regions: RegionGroup[];
}

export type Tone = "serious" | "playful";
export const TONES: readonly Tone[] = ["serious", "playful"];

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;
const KST_MS = 9 * 3600_000;
export const PARKED_CHAT_TURNS = 5;
export const REGULAR_DAYS = 5;
export const STEADY_ROUNDS = 10;
export const LONG_GAP_DAYS = 7;

const durationMin = (t: TripRow) => Math.max(1, Math.round((t.endedAt - t.startedAt) / MIN));
const kstDay = (ms: number) => Math.floor((ms + KST_MS) / DAY);
const regionKey = (t: TripRow) => (t.sido && t.sigungu ? `${t.sido}|${t.sigungu}` : null);

interface Ctx { trips: TripRow[]; memories: number; memoryAt: number | null }
interface Hit { earned: boolean; at: number | null }
const no: Hit = { earned: false, at: null };

interface Rule { id: string; playful: boolean; text: Record<Tone, { title: string; description: string }>; eval: (c: Ctx) => Hit }

/** 같은 곳을 서로 다른 날 5번 찾은 목적지가 있으면 5번째 날의 끝난 시각. */
function regular(c: Ctx): Hit {
  const days = new Map<string, Set<number>>();
  let best: number | null = null;
  for (const t of c.trips) {
    if (!t.destination) continue;
    const s = days.get(t.destination) ?? new Set<number>();
    s.add(kstDay(t.endedAt));
    days.set(t.destination, s);
    if (s.size === REGULAR_DAYS && best === null) best = t.endedAt;
  }
  return best === null ? no : { earned: true, at: best };
}

/** 같은 두 곳 사이를 오간 횟수(…A, B, A, B…에서 되돌아온 걸음)가 10번. 근사치다: 출발지를 모르니 목적지 순서로만 본다. */
function steady(c: Ctx): Hit {
  const counts = new Map<string, number>();
  const ds = c.trips.map((t) => t.destination);
  for (let i = 2; i < ds.length; i++) {
    const a = ds[i - 2], b = ds[i - 1], x = ds[i];
    if (!a || !b || !x || x !== a || a === b) continue;
    const key = [a, b].sort().join("|");
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n === STEADY_ROUNDS) return { earned: true, at: c.trips[i]!.endedAt };
  }
  return no;
}

const RULES: Rule[] = [
  { id: "first-ride", playful: false,
    text: { serious: { title: "첫 동행", description: "첫 길을 함께했어요." }, playful: { title: "첫 동행", description: "드디어 같이 타 줬네요, 기다렸어요." } },
    eval: (c) => (c.trips.length ? { earned: true, at: c.trips[0]!.endedAt } : no) },
  { id: "new-region", playful: false,
    text: { serious: { title: "새 동네", description: "새로운 동네를 열었어요." }, playful: { title: "새 동네", description: "어머, 이 동네는 처음이에요? 어땠는지 나중에 얘기해 줘요." } },
    eval: (c) => {
      const t = c.trips.find((x) => regionKey(x));
      return t ? { earned: true, at: t.endedAt } : no;
    } },
  { id: "regular", playful: true,
    text: { serious: { title: "단골", description: "자주 가시는 곳이 생겼어요." }, playful: { title: "단골", description: "여기 사장님이랑 친해지셨겠어요." } }, eval: regular },
  { id: "steady-road", playful: true,
    text: { serious: { title: "한결같은 길", description: "익숙한 길이 생겼어요." }, playful: { title: "한결같은 길", description: "이 길은 이제 제가 외웠어요. 내일도 같은 길이죠?" } }, eval: steady },
  { id: "relaxed-day", playful: true,
    text: { serious: { title: "느긋한 하루", description: "주차한 뒤에도 인사를 나눴어요." }, playful: { title: "느긋한 하루", description: "시동 끄고 수다 떨러 오셨군요." } },
    eval: (c) => {
      const t = c.trips.find((x) => x.parkedTurns >= 1);
      return t ? { earned: true, at: t.endedAt } : no;
    } },
  { id: "parking-master", playful: true,
    text: { serious: { title: "주차장 장인", description: "주차하고 이야기가 길게 이어졌어요." }, playful: { title: "주차장 장인", description: "차 안이 제일 편한 수다방이죠?" } },
    eval: (c) => {
      const t = c.trips.find((x) => x.parkedTurns >= PARKED_CHAT_TURNS);
      return t ? { earned: true, at: t.endedAt } : no;
    } },
  { id: "welcome-back", playful: true,
    text: { serious: { title: "오랜만이에요", description: "다시 만나서 반가워요." }, playful: { title: "오랜만이에요", description: "어디 갔다 왔어요, 나 안 잊었죠?" } },
    eval: (c) => {
      for (let i = 1; i < c.trips.length; i++) if (c.trips[i]!.startedAt - c.trips[i - 1]!.endedAt > LONG_GAP_DAYS * DAY) return { earned: true, at: c.trips[i]!.startedAt };
      return no;
    } },
  { id: "memory-keeper", playful: false,
    text: { serious: { title: "기억 수집가", description: "헤이파리가 기억해 둔 이야기가 다섯 개가 됐어요." }, playful: { title: "기억 수집가", description: "제 수첩이 슬슬 두꺼워지고 있어요." } },
    eval: (c) => (c.memories >= 5 ? { earned: true, at: c.memoryAt } : no) },
];

export function totalKm(trips: TripRow[]): number | null {
  const withKm = trips.filter((t) => t.distanceKm !== null);
  return withKm.length ? Math.round(withKm.reduce((s, t) => s + (t.distanceKm ?? 0), 0) * 10) / 10 : null;
}

/** 기억 수집가의 얻은 시각은 기억 쪽에서 오므로 호출한 쪽이 넘긴다(없으면 지금). */
export function computeBadges(tripsAsc: TripRow[], memories: number, memoryEarnedAt: number | null, now: number, tone: Tone = "serious"): BadgeView[] {
  const ctx: Ctx = { trips: tripsAsc, memories, memoryAt: memoryEarnedAt };
  return RULES.map((r) => {
    const hit = r.eval(ctx);
    const text = r.text[tone];
    return { id: r.id, title: text.title, description: text.description, playful: r.playful, earned: hit.earned, earnedAt: hit.earned ? iso(hit.at ?? now) : null };
  });
}

/** 가 본 시·군·구만. 안 가 본 곳은 목록에 없다. */
export function computeRegions(tripsAsc: TripRow[]): RegionGroup[] {
  const first = new Map<string, { at: number; trips: number; demo: boolean }>();
  for (const t of tripsAsc) {
    const k = regionKey(t);
    if (!k) continue;
    const cur = first.get(k);
    if (cur) {
      cur.trips++;
      cur.demo = cur.demo && t.regionDemo;
    } else first.set(k, { at: t.endedAt, trips: 1, demo: t.regionDemo });
  }
  const out: RegionGroup[] = [];
  for (const sido of SIDO_LIST) {
    const unlocked: RegionGroup["unlocked"] = [];
    for (const g of REGIONS[sido]!) {
      const f = first.get(`${sido}|${g}`);
      if (f) unlocked.push({ name: g, firstAt: iso(f.at), trips: f.trips, demo: f.demo });
    }
    if (unlocked.length) out.push({ sido, unlocked });
  }
  return out;
}

export function tripView(t: TripRow): TripView {
  return {
    id: t.id,
    startedAt: iso(t.startedAt),
    endedAt: iso(t.endedAt),
    durationMin: durationMin(t),
    distanceKm: t.distanceKm,
    destination: t.destination,
    region: t.sido && t.sigungu ? `${t.sido} ${t.sigungu}` : null,
  };
}

export function buildTripsResponse(tripsAsc: TripRow[], memories: number, memoryEarnedAt: number | null, now: number, tone: Tone = "serious"): TripsResponse {
  const badges = computeBadges(tripsAsc, memories, memoryEarnedAt, now, tone);
  const regions = computeRegions(tripsAsc);
  return {
    enabled: true,
    tone,
    stats: {
      tripCount: tripsAsc.length,
      totalKm: totalKm(tripsAsc),
      regionCount: regions.reduce((n, r) => n + r.unlocked.length, 0),
      sidoCount: regions.length,
      badgeCount: badges.filter((b) => b.earned).length,
    },
    trips: [...tripsAsc].reverse().map(tripView),
    badges,
    regions,
  };
}

export const emptyTripsResponse = (tone: Tone = "serious"): TripsResponse => ({
  enabled: false,
  tone,
  stats: { tripCount: 0, totalKm: null, regionCount: 0, sidoCount: 0, badgeCount: 0 },
  trips: [],
  badges: computeBadges([], 0, null, 0, tone),
  regions: [],
});

// ---- 차에서 온 값 정리(좌표 없음) ----

const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*[,/ ]\s*-?\d{1,3}\.\d{3,}/;
/** 목적지 이름. 좌표처럼 보이면 버리고 40자로 자른다. */
export function cleanDestination(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t || COORD_PAIR.test(t)) return null;
  return [...t].slice(0, 40).join("");
}

export interface RegionPick extends Region { demo: boolean }
/** 지역: 차가 준 region 값 → 목적지 이름 → 데모 설정(COMPANION_DEMO_REGION="경기도 하남시") 순. 못 정하면 null. */
export function pickRegion(carRegion: unknown, destination: string | null, demoRegion: string | undefined): RegionPick | null {
  if (typeof carRegion === "string") {
    const r = findRegion(carRegion);
    if (r) return { ...r, demo: false };
  }
  if (destination) {
    const r = findRegion(destination);
    if (r) return { ...r, demo: false };
  }
  if (demoRegion) {
    const r = findRegion(demoRegion);
    if (r) return { ...r, demo: true };
  }
  return null;
}
