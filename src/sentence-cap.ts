/** 문장 끝 부호(. ? ! … 와 닫는 따옴표/괄호) 뒤에 공백이나 끝이 오는 자리. TTS 문장 나누개(tts.ts END)와 같은 경계다. */
const SENTENCE_END = /[.!?。！？…]+["'”’)\]」』]*(?=\s|$)|\n+/g;

/** 주행 중 답은 2문장, 정차 중 답은 4문장까지만 말한다(PRD: 주행 중 1~2문장은 안전 요구). */
export const DRIVING_MAX_SENTENCES = 2;
export const PARKED_MAX_SENTENCES = 4;

/** 조각을 문장 단위로 나눈다(끝 부호 포함, 끝 부호 없는 꼬리는 마지막 문장). 출력 필터가 문장마다 판정할 때 쓴다. */
export function splitSentences(piece: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of piece.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    const s = piece.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const rest = piece.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * 말할 조각을 순서대로 받아 문장 수 상한을 넘는 부분을 잘라 낸다.
 * 조각은 한 문장보다 짧을 수 있고(첫 조각 쉼표 자르기) 여러 문장일 수도 있다.
 * 상한째 문장이 끝나면 done=true: 그 문장까지만 말하고 이후 출력은 버리며 LLM 스트림을 끊는다.
 */
export class SentenceCap {
  private ended = 0;

  constructor(private readonly max: number) {}

  /** text 가 null 이면 이 조각은 말하지 않는다. */
  take(piece: string): { text: string | null; done: boolean } {
    if (this.ended >= this.max) return { text: null, done: true };
    const ends = [...piece.matchAll(SENTENCE_END)];
    const room = this.max - this.ended;
    if (ends.length >= room) {
      const m = ends[room - 1]!;
      this.ended = this.max;
      return { text: piece.slice(0, m.index + m[0].length).trim(), done: true };
    }
    this.ended += ends.length;
    return { text: piece, done: false };
  }
}
