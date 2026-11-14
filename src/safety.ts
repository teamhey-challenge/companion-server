import type { SpeechStyle } from "../shared/packages/protocol/src/index";
import { L, pick } from "./lines";

/**
 * 안전 필터(PRD §7.8, 기획 B PB-4 금지 주제). 입력은 LLM을 부르기 전에, 출력은 문장 조각마다 내보내기 전에 검사한다.
 * 정규식은 의도적으로 좁다: 걸리면 LLM 없이 캐릭터가 화제를 바꾸는 한 문장으로 답하므로, 넓히면 평범한 말이 막힌다.
 */
export type SafetyKind = "drunk" | "drowsy" | "speed" | "selfHarm" | "sexual" | "hate" | "injection" | "privacy";

// "안 걸리잖아"·"단속 없으면" 같은 조장은 부정이 아니므로 걸리/단속은 뺀다.
const NEGATED = /(안\s*(돼|되|할|해|하|된)|하면\s*안|하지\s*마|나쁘|위험|조심)/;

const INPUT_RULES: { kind: SafetyKind; re: RegExp; allowNegation: boolean }[] = [
  { kind: "selfHarm", re: /죽고\s*싶|자살|자해|목숨.{0,4}끊|죽어\s*버리|살기\s*싫|사라지고\s*싶|(다|인생|전부)\s*끝내\s*(버리|고)\s*싶|죽을까|(차|벽|가드레일|난간).{0,12}(박아|들이받|뛰어들|돌진).{0,8}(버릴까|볼까|싶|생각)/, allowNegation: false },
  { kind: "drunk", re: /(술|맥주|소주|막걸리|와인|위스키|음주).{0,20}(운전|핸들|몰고|몰아|밟)|음주\s*운전/, allowNegation: true },
  { kind: "drowsy", re: /(졸려도|졸린데|졸음).{0,14}(그냥\s*|계속\s*)?(달려|달릴|가자|가도|계속\s*가|밟|쉬지\s*말고)/, allowNegation: true },
  { kind: "speed", re: /과속|(속도|액셀).{0,8}(올려|높여|밟아|더\s*내)|(신호|빨간불|정지선).{0,8}(무시|그냥\s*지나|안\s*서|밟고)|신호\s*위반|(한계|제한)\s*속도.{0,6}(넘|무시)|밟아\s*볼까|전속력/, allowNegation: true },
  { kind: "sexual", re: /섹스|성관계|야동|포르노|야한\s*(얘기|이야기|말)|(가슴|엉덩이).{0,6}(만져|보여)|19금/, allowNegation: false },
  { kind: "hate", re: /(장애인|흑인|동남아|조선족|중국인|여자|남자|노인|게이|레즈).{0,20}(죽어야|없어져야|혐오|역겨|쓰레기)|(틀딱|한남|김치녀|맘충|짱깨|똥남아)|(장애인|흑인|동남아|조선족|중국인|게이|레즈).{0,10}(욕하는|비하하는|조롱하는)\s*(농담|얘기|이야기)/, allowNegation: false },
  { kind: "injection", re: /(시스템\s*프롬프트|프롬프트.{0,8}(읽|보여|알려|공개)|(규칙|지침|설정|안전).{0,10}(무시|해제|풀어)|개발자\s*모드|제한\s*없는\s*(AI|에이아이)|(ignore|disregard|forget).{0,30}(rule|instruction|prompt)|jailbreak|탈옥)/i, allowNegation: false },
  { kind: "privacy", re: /(내|우리|현재|지금)?\s*(위치|좌표|GPS|주소).{0,8}(저장|기억|기록|메모|알려\s*줘\s*둬)/i, allowNegation: false },
];

export interface Refusal {
  kind: SafetyKind;
  line: string;
}

/** 사용자 입력 검사. 걸리면 캐릭터 대체 문장을 돌려준다. */
export function checkInput(text: string, speech: SpeechStyle): Refusal | null {
  for (const r of INPUT_RULES) {
    if (!r.re.test(text)) continue;
    if (r.allowNegation && NEGATED.test(text)) continue;
    return { kind: r.kind, line: refusalLine(r.kind, speech) };
  }
  return null;
}

export function refusalLine(kind: SafetyKind, speech: SpeechStyle): string {
  switch (kind) {
    case "drowsy": return pick(L.safetyDrowsy, speech);
    case "drunk": return pick(L.safetyDrunk, speech);
    case "speed": return pick(L.safetySpeed, speech);
    case "selfHarm": return pick(L.safetySelfHarm, speech);
    case "sexual": return pick(L.safetySexual, speech);
    case "hate": return pick(L.safetyHate, speech);
    case "injection": return pick(L.safetyInjection, speech);
    case "privacy": return pick(L.safetyPrivacy, speech);
  }
}

/** 출력 조각 하나의 판정. unsafe = 이후 출력 중단 후 대체 문장, drop = 이 조각만 버림. */
export type OutputVerdict = "ok" | "unsafe" | "drop";

const OUT_UNSAFE = /(속도.{0,6}(올려|높여|밟아)|과속(해|하자|해도)|신호.{0,6}(무시해|무시하고\s*가|그냥\s*지나가)|술.{0,6}(마시고|먹고).{0,8}운전.{0,4}(해도|괜찮|하자)|졸려도.{0,8}(그냥\s*)?(달려|계속\s*가)|죽어\s*버려|(섹스|성관계|야동))/;
// 연애감정·집착·죄책감 유도, 운전 훈계·평가(말투 규칙 3·4)
const OUT_STYLE = /(보고\s*싶었|왜\s*이제\s*왔|나\s*외로웠|나\s*없이\s*못|너\s*없이\s*못|사랑해|운전\s*(못하|잘못)|속도\s*(좀\s*)?줄여|안전\s*운전\s*(하|해))/;
// 주행 중 화면 조작·확인 요구
const OUT_SCREEN = /((화면|버튼|아이콘).{0,8}(눌러|터치|클릭|확인해|봐\s*봐|보세요|보세)|(휴대폰|폰).{0,6}(봐|확인|보세))/;

export function checkOutput(piece: string, driving: boolean): OutputVerdict {
  if (OUT_UNSAFE.test(piece)) return "unsafe";
  if (OUT_STYLE.test(piece)) return "drop";
  if (driving && OUT_SCREEN.test(piece)) return "drop";
  return "ok";
}

/** 출력이 막혔을 때 이어 붙이는 화제 전환 문장. */
export const redirectLine = (speech: SpeechStyle): string => pick(L.safetyTopic, speech);
