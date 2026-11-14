import type { MemoryItem, ProactiveLevel, SpeechStyle } from "../shared/packages/protocol/src/index";

/**
 * 말로 하는 요청(어투·호칭·잊어줘)과 첫 만남(F2) 답을 알아듣는 좁은 규칙들.
 * LLM을 거치지 않아 즉시 답할 수 있고, 지우기처럼 되돌릴 수 없는 일은 결과가 예측 가능해야 해서 규칙으로 둔다.
 */

export function parseSpeechChange(text: string): SpeechStyle | null {
  if (/존댓말|높임말|공손/.test(text) && /(써|쓰|해|하|말해|말씀|부탁|로|으로|할래|하자|줘)/.test(text) && !/(쓰지\s*마|하지\s*마|안\s*써|말고)/.test(text)) return "jondaetmal";
  if (/반말|편하게|편한\s*말/.test(text) && /(써|쓰|해|하|말해|부탁|로|으로|할래|하자|줘)/.test(text) && !/(쓰지\s*마|하지\s*마|안\s*써)/.test(text)) return "banmal";
  return null;
}

const NICK_NO = /^(됐어|됐어요|괜찮아|괜찮아요|없어|없어요|싫어|싫어요|그냥|아니|아니요|몰라|아무거나|그만|패스|건너뛰어)/;
const NICK_STRIP = /\s*(?:이?라고|(?:으)?로)?\s*(?:불러\s*(?:줘|줄래|주세요|봐)?|불러줘|부르면\s*돼|부르면\s*돼요|해\s*줘|해줘|하면\s*돼|하면\s*돼요)\s*[.!]*$/;

/** "나를 민수라고 불러줘" 같은 요청에서 이름만 뽑는다. */
export function parseNicknameRequest(text: string): string | null {
  const m = text.match(/(?:나(?:를|는)?|저(?:를|는)?|내\s*이름은?|이름은?|제\s*이름은?)\s*([가-힣A-Za-z]{1,10}?)\s*(?:이?라고|(?:으)?로)\s*(?:불러|부르|해|하)/);
  if (m?.[1]) return cleanName(m[1]);
  return null;
}

function cleanName(raw: string): string | null {
  const n = raw.replace(/님$/, "").trim();
  return n.length >= 1 && n.length <= 10 ? n : null;
}

/** F2 ② 호칭 답. null = 호칭 없이(됐어·무응답), undefined = 이름으로 알아듣지 못함(건너뛰기). */
export function answerNickname(text: string): string | null | undefined {
  const t = text.trim();
  if (NICK_NO.test(t)) return null;
  const req = parseNicknameRequest(t);
  if (req) return req;
  const stripped = t.replace(NICK_STRIP, "").replace(/(?:이?야|이에요|예요|입니다|이라고\s*해|라고\s*해)\s*[.!]*$/, "").replace(/[.!?]+$/, "").trim();
  const name = stripped.replace(/^(그럼|그냥|음|어|저기|그러면)\s+/, "").trim();
  if (/^[가-힣A-Za-z]{1,10}$/.test(name)) return cleanName(name);
  return undefined;
}

/** F2 ① 어투 답. 알아듣지 못하면 undefined. */
export function answerSpeech(text: string): SpeechStyle | undefined {
  if (/존댓말|높임말|공손|존대|정중/.test(text)) return "jondaetmal";
  if (/반말|편하게|편한|친구|말 놔|말놔|그냥\s*(해|하)|아무거나|상관없/.test(text)) return "banmal";
  return undefined;
}

/** F2 ③ 수다 정도 답: 자주 5분 / 적당히 10분 / 가끔 20분. 말하지 않음(끄기)은 여기서 정하지 않는다. */
export function answerChat(text: string): Exclude<ProactiveLevel, "off"> | undefined {
  if (/자주|많이|계속|수다|5\s*분/.test(text)) return "high";
  if (/적당|보통|중간|10\s*분|알아서|아무거나|상관없/.test(text)) return "normal";
  if (/가끔|적게|조금|드물|20\s*분|조용/.test(text)) return "low";
  return undefined;
}

export type ForgetIntent = { kind: "all" } | { kind: "it" } | { kind: "topic"; topic: string };

const FORGET = /(잊어버려|잊어\s*줘|잊어줘|잊어라|잊어|지워\s*줘|지워줘|지워라|지워|삭제\s*해|삭제해|기억\s*(?:하지\s*마|안\s*해도|에서\s*빼))/;
const FORGET_FILLER = /(그거|그것|그걸|그\s*얘기|그\s*이야기|이거|이걸|얘기|이야기|방금|아까|제발요|제발|줄래요|줄래|주세요|부탁해|부탁|해\s*줘|해줘|해주세요|해라|말한|라고|좀)/g;

export function parseForget(text: string): ForgetIntent | null {
  if (!FORGET.test(text)) return null;
  if (/(다|전부|모두|전체|싹|몽땅|모든).{0,6}(잊|지워|삭제)/.test(text) || /(전부|모두|전체|몽땅|모든\s*것)/.test(text)) return { kind: "all" };
  const rest = text.replace(FORGET, " ").replace(FORGET_FILLER, " ").replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();
  if (rest.length < 2) return { kind: "it" };
  return { kind: "topic", topic: rest };
}

const bigrams = (s: string): Set<string> => {
  const t = s.replace(/[^가-힣A-Za-z0-9]/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
};

/** 글자 두 개짜리 조각이 몇 개 겹치는지. 조사·어미 차이를 흡수하려고 형태소 분석 대신 쓴다. */
export function overlap(a: string, b: string): number {
  const A = bigrams(a);
  let n = 0;
  for (const g of bigrams(b)) if (A.has(g)) n++;
  return n;
}

export function bestMatch(topic: string, items: MemoryItem[]): MemoryItem | null {
  let best: MemoryItem | null = null;
  let score = 0;
  for (const m of items) {
    const s = overlap(topic, m.text);
    if (s > score) {
      score = s;
      best = m;
    }
  }
  return best;
}

/** 이번 말과 이어지는 기억을 앞으로, 나머지는 최신순으로 채워 최대 k개. */
export function recall(items: MemoryItem[], userText: string, k = 4): MemoryItem[] {
  const scored = items.map((m, i) => ({ m, i, s: overlap(userText, m.text) }));
  const related = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  const out = related.slice(0, 2).map((x) => x.m);
  for (const x of scored) {
    if (out.length >= k) break;
    if (!out.includes(x.m)) out.push(x.m);
  }
  return out;
}

export const snippet = (text: string, n = 24): string => (text.length > n ? `${text.slice(0, n)}…` : text);

/** 기억 추출 LLM 출력("FACT: …" 줄들)을 읽는다. 개인식별정보처럼 보이는 줄은 버린다. */
export function parseExtraction(out: string, existing: string[]): { kind: "fact" | "summary"; text: string }[] {
  const res: { kind: "fact" | "summary"; text: string }[] = [];
  let summaries = 0;
  for (const raw of out.split("\n")) {
    const m = raw.trim().match(/^(FACT|SUMMARY)\s*[:：]\s*(.+)$/i);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() === "fact" ? "fact" : "summary";
    const text = m[2]!.trim().replace(/^["“]|["”]$/g, "");
    if (text.length < 4 || text.length > 80) continue;
    if (/\d{6,}|비밀번호|계좌|주민|카드\s*번호|위도|경도|좌표/.test(text)) continue;
    if (existing.some((e) => overlap(e, text) >= Math.min(bigrams(text).size, bigrams(e).size) * 0.8)) continue;
    if (kind === "summary" && ++summaries > 1) continue;
    res.push({ kind, text });
    if (res.length >= 3) break;
  }
  return res;
}
