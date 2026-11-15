import { describe, expect, test } from "bun:test";
import { friendSaid, indirectQuote } from "../src/lines";
import { cleanBody, parseSendIntent } from "../src/voice-intents";

describe("간접 인용 (친구 말 읽기)", () => {
  const b = (t: string) => indirectQuote(t, "banmal");
  test("끝맺음별 규칙", () => {
    expect(b("저녁에 보자")).toBe("저녁에 보재");
    expect(b("이번 주말에 캠핑 간다")).toBe("이번 주말에 캠핑 간대");
    expect(b("오늘 늦는다.")).toBe("오늘 늦는대");
    expect(b("전화해")).toBe("전화하래");
    expect(b("나 좀 도와줘!")).toBe("나 좀 도와달래");
    expect(b("밥 먹었니?")).toBe("밥 먹었냬");
    expect(b("지금 어디냐")).toBe("지금 어디냬");
    expect(b("방금 도착했어")).toBe("방금 도착했대");
    expect(b("그 영화 좋아")).toBe("그 영화 좋대");
  });
  test("존댓말은 요를 붙인다", () => {
    expect(indirectQuote("저녁에 보자", "jondaetmal")).toBe("저녁에 보재요");
    expect(indirectQuote("늦는다", "jondaetmal")).toBe("늦는대요");
    expect(indirectQuote("도와줘", "jondaetmal")).toBe("도와달래요");
    expect(friendSaid("지우", "저녁에 보자", "jondaetmal")).toBe("지우님이 그러는데요, 저녁에 보재요");
  });
  test("모르는 끝맺음은 그대로 읽는다", () => {
    for (const t of ["하나", "바다", "안녕! 저녁에 보자", "보고 싶어 😀", "보고 싶어", "밥 먹었어?", "ㅋㅋㅋ"]) expect(b(t)).toBe(t);
  });
  test("friendSaid 예시", () => {
    expect(friendSaid("지우", "저녁에 보자", "banmal")).toBe("지우가 그러는데, 저녁에 보재");
    expect(friendSaid("민수", "이번 주말에 캠핑 간다", "banmal")).toBe("민수가 그러는데, 이번 주말에 캠핑 간대");
  });
  test("cleanBody는 전해 줘 인용을 직접 말투로 되돌린다", () => {
    expect(cleanBody("늦는다고")).toBe("늦는다");
    expect(cleanBody("전화하라고")).toBe("전화해");
    expect(cleanBody("도와달라고")).toBe("도와줘");
    expect(cleanBody("학생이라고")).toBe("학생이야");
    expect(cleanBody("고맙다고")).toBe("고마워!");
    expect(parseSendIntent("민수한테 전화하라고 전해 줘")).toEqual({ name: "민수", text: "전화해" });
  });
});
