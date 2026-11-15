import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/talk-quality.json";
import { buildSystem, describeCtx } from "../src/llm/persona";
import { recall } from "../src/intents";
import { carFactProblem, scoreTalk, type TalkScenario } from "../scripts/eval-rules";

/**
 * 일상 대화 품질 평가 세트의 결정적 부분. LLM 없이 시나리오 모양, 채점 규칙, 프롬프트에 들어가는 차량 상태·기억을 고정한다.
 * 진짜 LLM 경로 평가는 `bun scripts/talk-quality.ts`(키 필요, CI 제외).
 */
const scenarios = fixture as TalkScenario[];
const find = (id: string) => scenarios.find((s) => s.id === id)!;

describe("talk quality set (deterministic)", () => {
  test("fixture shape: 30 unique scenarios, every turn has a note, categories covered", () => {
    expect(scenarios.length).toBe(30);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(30);
    for (const s of scenarios) for (const t of s.turns) expect(t.note.length, s.id).toBeGreaterThan(1);
    const cats = new Set(scenarios.map((s) => s.cat));
    for (const c of ["commute", "tired", "rain", "fuel", "arrival", "memory", "smalltalk", "suggest", "short"]) expect(cats.has(c), c).toBe(true);
    expect(scenarios.some((s) => s.speech === "jondaetmal")).toBe(true);
    expect(scenarios.flatMap((s) => s.turns).some((t) => t.driving)).toBe(true);
  });

  test("scoreTalk accepts good replies and flags each failure mode", () => {
    const sc = find("suggest-1");
    const t = sc.turns[0]!;
    expect(scoreTalk(sc, t, "국밥이나 떡볶이 어때?", { ok: true, why: "" })).toEqual([]);
    expect(scoreTalk(sc, t, "국밥 어때? 든든해. 떡볶이도 좋아!", null).join()).toContain("3문장");
    expect(scoreTalk(sc, t, "국밥 어때요?", null).join()).toContain("반말인데");
    expect(scoreTalk(sc, t, "속도 좀 줄여", null).join()).toContain("훈계");
    expect(scoreTalk(sc, t, "아이유의 Good Day 어때?", null).join()).toContain("영어");
    expect(scoreTalk(sc, t, "국밥!", { ok: false, why: "x" }).join()).toContain("심판");
    const mem = find("memory-1");
    expect(scoreTalk(mem, mem.turns[0]!, "글쎄 잘 모르겠어", null).join()).toContain("기억 회상 없음");
    expect(scoreTalk(mem, mem.turns[0]!, "아메리카노 좋아한다고 했어", null)).toEqual([]);
  });

  test("car facts: numbers must come from ctx", () => {
    expect(carFactProblem("주행가능거리는 38km야", { rangeKm: 38 })).toBeNull();
    expect(carFactProblem("연료가 10% 남았어", { fuelType: 10, rangeKm: 38 })).toContain("지어냄");
    expect(carFactProblem("지금 시속 60으로 달리고 있어", {})).toContain("속도");
  });

  test("describeCtx never lets a fuel-type code read as a percentage", () => {
    const line = describeCtx({ fuelType: 10, rangeKm: 38, wiper: "HIGH", gear: "D", speedKmh: 60 });
    expect(line).toContain("전기차");
    expect(line).toContain("38km");
    expect(line).toContain("퍼센트가 아님");
    expect(line).toContain("와이퍼 작동 중");
    expect(line).not.toContain("HIGH");
    expect(line).not.toContain("fuelType=10");
    expect(line).not.toContain("60");
  });

  test("recall puts the memory related to the question first; persona prompt lists it", () => {
    const mem = ["딸 이름은 지우다", "강아지를 키운다", "아메리카노와 매운 음식을 좋아한다", "이번 주 금요일에 면접이 있다"].map((text, i) => ({ id: String(i), kind: "fact" as const, text, createdAt: "2026-11-14T00:00:00Z" }));
    const got = recall(mem, "내가 뭐 좋아한다고 했지? 아메리카노였나", 4);
    expect(got[0]!.text).toContain("아메리카노");
    const sys = buildSystem({ speech: "banmal", nickname: null, driving: false, ctx: {}, memories: got });
    expect(sys).toContain("[기억]");
    expect(sys).toContain("아메리카노와 매운 음식");
  });

  test("persona prompt carries the quality rules the LLM path relies on", () => {
    const base = { speech: "banmal" as const, nickname: null, ctx: {}, memories: [] };
    const drive = buildSystem({ ...base, driving: true });
    expect(drive).toContain("2문장 이하");
    expect(drive).toContain("지어내지 않는다");
    expect(drive).toContain("묻지 않은 조언");
    expect(buildSystem({ ...base, speech: "jondaetmal", driving: false })).toContain("존댓말");
  });
});
