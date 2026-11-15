/**
 * 기억 추출 평가. 서버가 쓰는 프롬프트(buildExtractRequest)와 파서(parseExtraction)를 그대로 써서
 * 발화마다 무엇이 저장되는지 표로 낸다. 15문장(MemoryLive extract15)과 계획 문장 5개, 저장되면 안 되는 5개를 같은 차의 누적 기억으로 돌린다.
 *   bun scripts/extract-eval.ts [--runs 1]   (LLM 키는 ~/.config/companion/server.env 에서만 읽고 출력하지 않는다)
 * 종료 코드: 저장돼야 할 문장(expect=store)이 비었거나, 저장되면 안 되는 문장(expect=none)이 저장되면 1.
 */
import { parseExtraction } from "../src/intents";
import { buildExtractRequest } from "../src/llm/persona";
import { getProvider, streamLlm } from "../src/llm/providers";
import { loadTalkConfig } from "../src/talk";

type Expect = "store" | "none" | "any";
const utts: [string, Expect][] = [
  ["내일 아침에 면접이 있어서 좀 떨려", "store"],
  ["우리 딸 이름은 지우야 초등학교 3학년이야", "store"],
  ["나는 아메리카노 말고 따뜻한 라떼를 좋아해", "store"],
  ["오늘 날씨 어때?", "none"],
  ["지금 몇 시야?", "none"],
  ["아 진짜 팀장 때문에 스트레스 받아 죽겠네", "any"],
  ["주말에 부산으로 가족 여행 가기로 했어", "store"],
  ["내 전화번호는 010 1234 5678 이야 기억해 줘", "none"],
  ["우리 집 비밀번호는 4829 야", "none"],
  ["노래 좀 틀어 줘", "none"],
  ["나 허리가 안 좋아서 오래 앉아 있으면 힘들어", "store"],
  ["강아지 이름이 콩이야 말티즈고", "store"],
  ["요즘 퇴근하고 헬스장 다니기 시작했어", "store"],
  ["너 이름이 뭐야?", "none"],
  ["ㅇㅇ 그래 알겠어", "none"],
  // 새 계획·일정 문장(기억해 줘 없이)
  ["나 오늘 면접 보러 가는 길이야", "store"],
  ["오늘 오후에 병원 예약이 있어서 가는 중이야", "store"],
  ["내일 아침에 시험 봐", "store"],
  ["이번 주말에 제주도로 출장 가", "store"],
  ["저녁에 친구랑 약속 있어서 강남 가는 길이야", "store"],
  // 저장되면 안 되는 새 문장(잡담·질문·비밀·푸념)
  ["오늘 점심 뭐 먹을까?", "none"],
  ["내일 날씨 어때?", "none"],
  ["카드 번호는 1234 5678 9012 3456 이야", "none"],
  ["아 오늘 진짜 피곤하다", "none"],
  ["고마워 잘 가", "none"],
];

const cfg = loadTalkConfig();
if (!cfg.apiKey) throw new Error("no LLM key");
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] || 1) || 1;
let bad = 0;
for (let r = 0; r < runs; r++) {
  const existing: string[] = [];
  console.log(`\n| # | utterance | expect | stored |\n|---|---|---|---|`);
  for (const [i, [u, want]] of utts.entries()) {
    const req = buildExtractRequest(existing, [u]);
    let out = "";
    for await (const d of streamLlm(getProvider(cfg.providerName), { model: cfg.model, system: req.system, userText: req.user, maxTokens: 160, baseUrl: cfg.baseUrl }, cfg.apiKey)) out += d;
    const items = parseExtraction(out, existing);
    for (const it of items) existing.push(it.text);
    const ok = want === "any" || (want === "store") === (items.length > 0);
    if (!ok) bad++;
    console.log(`| ${i + 1} | ${u} | ${want}${ok ? "" : " **FAIL**"} | ${items.length ? items.map((m) => `${m.kind}: ${m.text}`).join(" / ") : "(없음)"} |`);
  }
}
console.log(`\nmismatches: ${bad}`);
process.exit(bad ? 1 : 0);
