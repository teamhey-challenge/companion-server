# companion-server

차량 캐릭터 AI 컴패니언(임시 이름 `companion-*`)의 서버 저장소다. HEY 시절 `hey-relay@3939310`에서 재사용할 뼈대만 복사했다(원본 저장소는 그대로 보관).

음성 인식(STT)과 음성 합성(TTS)은 차량의 Pleos 내장 서비스가 맡으므로 이 서버는 오디오 바이너리를 받지 않는다. 서버가 하는 일은 대화 텍스트를 받아 LLM을 부르는 것뿐이고, LLM 연동(Claude·OpenAI·Gemini 선택)은 이 뼈대에 아직 들어 있지 않다.

## 남아 있는 부품

| 파일 | 내용 |
|---|---|
| `src/index.ts` | `/healthz`만 있는 서버 진입점 |
| `src/observe.ts` | 한 줄 JSON 로그와 오류 코드 집계 |
| `src/process-guard.ts` | 처리되지 않은 예외·종료 신호 방어, 로그 쓰기 |
| `src/rate-limit.ts`, `src/clock.ts` | 기기별 요청 한도, 시험용 가짜 시계·타이머 |
| `src/persist.ts` | 원자적 JSON 쓰기(0600) |
| `scripts/run-relay.sh` | 로그 회전하며 분리 기동 (`HEY_*` 이름은 그대로) |

## 점검

```sh
git clone --recurse-submodules git@github.com:darren-pleos-challenge/companion-server.git
bun install
bun run check   # 단위 시험 + tsc
```

`shared/`는 `companion-shared` v0.1.0 서브모듈이다. 비밀값(API 키)은 저장소에 두지 않고 `~/.config/companion/`의 600 파일로만 읽는다.
