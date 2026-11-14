import { expect, test } from "bun:test";
import { buildExtractRequest } from "../src/llm/persona";

test("extract request: plain plan statements count as facts without 'remember this'; only the latest utterance is the source", () => {
  const r = buildExtractRequest(["딸 이름은 지우다"], ["안녕", "나 오늘 면접 보러 가는 길이야"]);
  expect(r.system).toContain("기억해 줘");
  expect(r.system).toContain("면접");
  expect(r.system).toContain("- 딸 이름은 지우다");
  expect(r.user).toContain("앞선 말(맥락 참고용, 여기서는 뽑지 않는다):\n- 안녕");
  expect(r.user.endsWith("이번 말(여기서만 뽑는다):\n- 나 오늘 면접 보러 가는 길이야")).toBe(true);
  expect(buildExtractRequest([], ["내일 시험이야"]).system).toContain("(없음)");
});
