# companion-server

차량 캐릭터 AI 컴패니언(임시 이름 `companion-*`)의 서버 저장소다. HEY 시절 `hey-relay@3939310`에서 재사용할 뼈대만 복사했다(원본 저장소는 그대로 보관).

음성 인식(STT)과 음성 합성(TTS)은 차량의 Pleos 내장 서비스가 맡으므로 이 서버는 오디오 바이너리를 받지 않는다. 서버가 하는 일은 대화 텍스트를 받아 LLM을 부르는 것뿐이다. LLM 연동은 `companion-llm-spike`(`31b14bd`)에서 옮겨 왔고, 기본값은 OmniRoute(OpenAI 호환) `chat-fast`다.

## 남아 있는 부품

| 파일 | 내용 |
|---|---|
| `src/index.ts` | 서버 진입점: `/healthz`, 차량 등록·세션 발급, `/v1/talk` |
| `src/talk.ts` | `/v1/talk` 웹소켓 핸들러(턴 상태·취소·ctx 좌표 제거), 설정 로드 |
| `src/store.ts` | 차량 등록 sqlite(carToken은 해시만)와 한 번 쓰는 웹소켓 티켓 |
| `src/llm/` | provider 인터페이스, anthropic·openai·gemini·openai-compatible 어댑터, SSE 파서, 페르소나 초안(임시), 비밀 파일 로더 |
| `src/observe.ts` | 한 줄 JSON 로그와 오류 코드 집계 |
| `src/process-guard.ts` | 처리되지 않은 예외·종료 신호 방어, 로그 쓰기 |
| `src/rate-limit.ts`, `src/clock.ts` | 기기별 요청 한도, 시험용 가짜 시계·타이머 |
| `src/persist.ts` | 원자적 JSON 쓰기(0600) |
| `scripts/smoke.ts` | 서버를 띄워 한 턴을 보내고 firstTokenMs·totalMs·모델을 출력 |
| `scripts/run-relay.sh` | 로그 회전하며 분리 기동 (`HEY_*` 이름은 그대로) |

## 인증과 /v1/talk

프레임 정의와 검증기는 `shared/packages/protocol`(v0.2.0~)이 정본이다. 고정 공유 토큰은 없다.

1. `POST /v1/cars/register` — 헤더 `X-Provision-Secret`, 본문 `{"installId":"8~64자"}` → `{"carToken"}`. 틀리면 403. 같은 installId로 다시 하면 토큰이 바뀐다(이전 것은 무효).
2. `POST /v1/sessions` — `Authorization: Bearer <carToken>` → `{"sessionId","wsTicket","expiresInSec":60}`. 없거나 틀리면 401.
3. `WS /v1/talk?ticket=<wsTicket>` — 티켓은 한 번만, 60초 안에 쓴다. 없거나 틀리거나 이미 쓴 티켓은 업그레이드 전에 401.

텍스트 프레임(JSON)만 받는다. 앱→서버 바이너리는 `1003`으로 닫는다. 순서: `hello` → `turn.start` → `text`/`ctx` → `turn.end`(또는 `turn.cancel`). `ctx`의 좌표 키(`lat`·`lon`·`gps`·`location` 등)는 조용히 버리고 턴은 계속한다.

```
→ {"type":"hello","v":1,"appVersion":"1.0"}
→ {"type":"turn.start","turnId":"t1","trigger":"ptt"}
→ {"type":"text","turnId":"t1","text":"오늘 비 와서 천천히 갈게"}
→ {"type":"turn.end","turnId":"t1"}
← {"type":"reply.start","turnId":"t1","audio":{"format":"pcm_s16le","sampleRate":24000,"channels":1}}   (TTS 없으면 "audio":"none")
← {"type":"reply.delta","turnId":"t1","text":"..."}            (여러 번)
← (바이너리: PCM s16le 24kHz mono 조각)                         (여러 번)
← {"type":"reply.end","turnId":"t1","text":"...","firstTokenMs":..,"totalMs":..}
```

`turn.cancel` 뒤에는 그 턴의 프레임(텍스트·바이너리)을 더 보내지 않는다.

### 서버 TTS (D-21)

`reply.start.audio`는 `{"format":"pcm_s16le","sampleRate":24000,"channels":1}` 또는 `"none"`. LLM 답이 한 문장 끝날 때마다 BreezeBlue 스트리밍 TTS(`hey_voice.json` 설정, `instructions` 없음)를 시작하고(동시 2개), PCM 조각을 문장 순서대로 **바이너리 프레임**으로 보낸다. `reply.start`는 첫 오디오(또는 실패)가 정해질 때 나가고, 그 전에 온 텍스트 델타는 직후에 쏟아진다. TTS 꺼짐·키 없음·잔액 부족·공급사 오류면 `"none"`이라서 앱이 Pleos TTS로 읽는다. 중간에 실패하면 오디오만 거기서 끊기고 텍스트는 끝까지 간다. 오디오는 디스크에 쓰지 않는다. 목소리가 404면 원본 샘플로 복제를 한 번만 다시 만든다.

## 설정

| 변수 | 기본값 | 내용 |
|---|---|---|
| `LLM_PROVIDER` | `openai-compatible` | `anthropic` · `openai` · `gemini` · `openai-compatible` |
| `LLM_MODEL` | `chat-fast` | OmniRoute에서는 claude-haiku-5.5 → haiku-4.5 → deepseek 순으로 대체 |
| `LLM_BASE_URL` | 없음 | openai-compatible 전용, 예: `http://127.0.0.1:20128/v1` |
| `LLM_API_KEY` | 없음 | 키는 `~/.config/companion/server.env`(600 권한)에서만 읽는다. 예시는 `server.env.example` |
| `COMPANION_PROVISION_SECRET` | 없음(필수) | 차량 등록에 요구하는 비밀(`X-Provision-Secret`). 값이 없으면 서버가 시작하지 않는다(fail-closed). 환경변수 또는 600 권한 비밀 파일에서 읽는다. 앱·웹 소스에 넣지 않는다 |
| `BREEZE_API_KEY` | 없음 | BreezeBlue 키(600 파일에서만). 없으면 TTS 없이 `audio:"none"` |
| `COMPANION_TTS_PROVIDER` | `breeze` | `breeze` · `fake`(시험·CI용 가짜 PCM) · `off` |
| `COMPANION_VOICE_SAMPLE` | 없음 | 목소리를 잃었을 때(404) 복제를 다시 만들 원본 mp3 경로 |
| `COMPANION_DATA_DIR` | `./data` | sqlite 파일(`companion.sqlite`) 폴더. 컨테이너에서는 `/data`(이름 있는 볼륨) |
| `COMPANION_HTTP_PER_MIN` | `30` | IP별 등록·세션 발급 한도(분). 초과 시 429 |
| `COMPANION_TRUST_PROXY` | 없음 | `1`일 때만 `CF-Connecting-IP`/`X-Forwarded-For`를 클라이언트 IP로 믿는다. Cloudflare 터널 뒤에서는 `1` |
| `COMPANION_UPGRADES_PER_MIN` | `30` | IP별 업그레이드 시도 한도(분). 초과 시 429 |
| `COMPANION_TURNS_PER_MIN` | `20` | 연결별 turn 한도(분). 초과 시 `{"type":"error","code":"rate_limited"}`, LLM 호출 없음 |
| `COMPANION_TURNS_PER_DAY` | `300` | 서버 전체 하루 turn 한도(LLM 비용 상한). 같은 응답 |
| `HOST` | 모든 인터페이스 | 바인드 주소. 컨테이너 없이 쓸 때는 `127.0.0.1` 권장 |

`/healthz`는 인증 없이 열려 있고 공개 요청에는 `{"ok":true}`만 돌려준다. provider·model·오류 집계는 프록시 헤더 없는 루프백 요청에만 나온다.

## 점검

```sh
git clone --recurse-submodules git@github.com:darren-pleos-challenge/companion-server.git
bun install
bun run check   # 단위 시험 + tsc
bun run scripts/smoke.ts "오늘 비 와서 천천히 갈게"   # 실제 LLM 한 턴
```

`shared/`는 `companion-shared` v0.1.0 서브모듈이다. 비밀값(API 키)은 저장소에 두지 않고 `~/.config/companion/`의 600 파일로만 읽는다.
