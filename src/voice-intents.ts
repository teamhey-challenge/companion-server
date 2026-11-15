/**
 * 말로 친구에게 전하기: "민수한테 오늘 늦는다고 전해 줘", 방금 온 메시지에 "고맙다고 전해 줘".
 * 좁은 규칙이라 평범한 대화는 건드리지 않는다. 이름이 없으면 방금 메시지를 보낸 친구에게 답하는 말로만 읽는다.
 */
export interface SendIntent {
  /** 말한 친구 이름. null 이면 방금 메시지를 보낸 친구에게 답한다. */
  name: string | null;
  text: string;
}

const VERB = "(?:전해\\s*줘|전해줘|전해\\s*줄래|전해\\s*주세요|말해\\s*줘|말해줘|보내\\s*줘|보내줘|알려\\s*줘|알려줘)";
const WITH_NAME = new RegExp(`^(.{1,12}?)\\s*(?:한테|에게|께)\\s+(.+?)\\s*${VERB}\\s*[.!?]*$`);
const NO_NAME = new RegExp(`^(.{1,60}?)\\s*${VERB}\\s*[.!?]*$`);

/** "늦는다고" → "늦는다", "고맙다고" → "고마워!" */
function cleanBody(raw: string): string {
  const t = raw.trim().replace(/고$/u, "");
  return /^(고맙|고마워|감사)/.test(t) ? "고마워!" : t;
}

export function parseSendIntent(text: string): SendIntent | null {
  const t = text.trim();
  const named = WITH_NAME.exec(t);
  if (named) {
    const body = cleanBody(named[2]!);
    return body ? { name: named[1]!.trim(), text: body } : null;
  }
  const plain = NO_NAME.exec(t);
  if (plain) {
    const raw = plain[1]!.trim();
    // 이름 없는 형태는 "고맙다고 전해 줘"처럼 인용(…고)으로 끝나는 말만 답장으로 읽는다.
    if (!/(?:이?라|다|자|냐|래)고$/u.test(raw)) return null;
    const body = cleanBody(raw);
    return body ? { name: null, text: body } : null;
  }
  return null;
}

/** 이름이 맞는 친구들(정확히 같으면 그것만). 호칭 어미(야·아·이)는 떼고 본다. */
export function matchFriends<T extends { name: string }>(spoken: string, friends: T[]): T[] {
  const n = spoken.trim().replace(/[야아]$/u, "");
  if (!n) return [];
  const exact = friends.filter((f) => f.name === spoken.trim() || f.name === n);
  if (exact.length) return exact;
  return friends.filter((f) => f.name.includes(n) || n.includes(f.name));
}
