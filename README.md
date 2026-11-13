# companion-server

차량 캐릭터 AI 컴패니언(임시 이름 `companion-*`)의 서버 저장소다. HEY 시절 `hey-relay@3939310`에서 재사용할 뼈대만 복사했다(원본 저장소는 그대로 보관).

음성 인식(STT)과 음성 합성(TTS)은 차량의 Pleos 내장 서비스가 맡으므로 이 서버는 오디오 바이너리를 받지 않는다. 서버가 하는 일은 대화 텍스트를 받아 LLM을 부르는 것뿐이다. LLM 연동은 `companion-llm-spike`(`31b14bd`)에서 옮겨 왔고, 기본값은 OmniRoute(OpenAI 호환) `chat-fast`다.

## 남아 있는 부품

| 파일 | 내용 |
|---|---|
| `src/index.ts` | 서버 진입점: `/healthz`, `/v1/talk` |
| `src/talk.ts` | `/v1/talk` 웹소켓 핸들러, turn 검증(위치 키 거부), 설정 로드 |
| `src/llm/` | provider 인터페이스, anthropic·openai·gemini·openai-compatible 어댑터, SSE 파서, 페르소나 초안(임시), 비밀 파일 로더 |
| `src/observe.ts` | 한 줄 JSON 로그와 오류 코드 집계 |
| `src/process-guard.ts` | 처리되지 않은 예외·종료 신호 방어, 로그 쓰기 |
| `src/rate-limit.ts`, `src/clock.ts` | 기기별 요청 한도, 시험용 가짜 시계·타이머 |
| `src/persist.ts` | 원자적 JSON 쓰기(0600) |
| `scripts/smoke.ts` | 서버를 띄워 한 턴을 보내고 firstTokenMs·totalMs·모델을 출력 |
| `scripts/run-relay.sh` | 로그 회전하며 분리 기동 (`HEY_*` 이름은 그대로) |

## /v1/talk

텍스트 프레임(JSON)만 받는다. 바이너리(오디오) 프레임은 `1003 TEXT_ONLY`로 닫고, `ctx`에 `lat`·`lng`·`gps`·`location` 같은 위치 키가 있으면 `location_not_accepted`로 거부한다.

```
→ {"type":"turn","text":"오늘 비 와서 천천히 갈게","ctx":{"speedKph":0}}
← {"type":"reply.start","provider":"openai-compatible","model":"chat-fast"}
← {"type":"reply.delta","text":"..."}            (여러 번)
← {"type":"reply.end","firstTokenMs":..,"totalMs":..,"chars":..,"resolvedModel":"claude-haiku-5-5"}
```

## 설정

| 변수 | 기본값 | 내용 |
|---|---|---|
| `LLM_PROVIDER` | `openai-compatible` | `anthropic` · `openai` · `gemini` · `openai-compatible` |
| `LLM_MODEL` | `chat-fast` | OmniRoute에서는 claude-haiku-5.5 → haiku-4.5 → deepseek 순으로 대체 |
| `LLM_BASE_URL` | 없음 | openai-compatible 전용, 예: `http://127.0.0.1:20128/v1` |
| `LLM_API_KEY` | 없음 | 키는 `~/.config/companion/server.env`(600 권한)에서만 읽는다. 예시는 `server.env.example` |

## 점검

```sh
git clone --recurse-submodules git@github.com:darren-pleos-challenge/companion-server.git
bun install
bun run check   # 단위 시험 + tsc
bun run scripts/smoke.ts "오늘 비 와서 천천히 갈게"   # 실제 LLM 한 턴
```

`shared/`는 `companion-shared` v0.1.0 서브모듈이다. 비밀값(API 키)은 저장소에 두지 않고 `~/.config/companion/`의 600 파일로만 읽는다.
