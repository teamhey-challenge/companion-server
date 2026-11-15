# companion-server

차 안에서 함께 달리는 AI 친구 **헤이리**(앱 Hey, 팀 Team Hey)의 서버입니다. 차량 앱과 폰 앱에서 온 대화 텍스트로 LLM을 부르고, 답을 글자와 음성(PCM)으로 실시간 스트리밍합니다. 대화·기억·친구·일기·계정 연결을 한 프로세스에서 처리하며 Bun + TypeScript로 작성했습니다.

> [!NOTE]
> 음성 인식(STT)은 차량의 내장 서비스가 맡습니다. 서버는 마이크 오디오를 받지 않고, 글로 바뀐 발화만 받습니다.

## 기능

- **WebSocket 대화**: `/v1/talk`로 한 턴씩 주고받습니다. LLM 답은 글자 조각(`reply.delta`)으로 흘러가고, 문장이 끝날 때마다 스트리밍 TTS가 합성한 PCM이 바이너리 프레임으로 이어집니다. TTS를 쓸 수 없으면 `audio:"none"`을 보내 앱이 기기 TTS로 읽게 합니다.
- **기억**: 대화에서 사실과 요약을 추출해 저장하고, 이어지는 말을 할 때 관련 기억을 꺼내 씁니다. 폰에서 항목별·전체 삭제가 가능합니다.
- **먼저 말 걸기**: 차량 신호(와이퍼·라이트·도어·충전·기어·내비 잔여 거리 등)의 변화를 보고 서버가 말을 걸지 정합니다. 같은 이유로는 쿨다운이 있고, 주행 중 답은 2문장 이내입니다.
- **친구·요청·메시지**: 초대 코드로 친구를 맺고, 120자 이하 메시지를 보냅니다. 안전 필터를 거치며 신고할 수 있습니다. "민수한테 늦는다고 전해 줘"처럼 말로도 보냅니다.
- **여정 일기**: 주차(기어 P + 운전석 도어 열림)하면 폰에 여정 종료를 알리고, 그날의 일기를 LLM이 짧게 씁니다. 좌표는 쓰지 않고 목적지 이름만 남깁니다.
- **폰 구글 로그인과 차 연결**: 구글 ID 토큰을 검증해 폰 계정을 만들고, 차가 보여 주는 6자 코드로 폰과 차를 연결합니다.
- **개인정보 삭제**: 동의 항목별 철회, 기억 삭제, 연결 해제를 지원합니다. 기억·녹음 동의를 철회하면 그 계정의 일기와 친구 메시지가 즉시 삭제됩니다.

## 구조

```
src/
├── index.ts          진입점: 환경 설정을 읽고 서버 시작, 고정 문장 TTS 예열
├── server.ts         HTTP/WebSocket 서버, 차량 등록·세션 발급, 요청 한도
├── api.ts            폰·차용 REST 라우터 (동의·연결·기억·설정·친구·메시지·일기)
├── api-store.ts      계정·동의·기억·연결 저장소 (SQLite)
├── social.ts         친구·메시지·일기 흐름과 푸시
├── social-store.ts   친구·메시지·일기 저장소 (SQLite)
├── talk.ts           /v1/talk 핸들러: 턴 상태, 취소, 기억 추출, 먼저 말 걸기
├── proactive.ts      차량 신호로 먼저 말 걸기를 정하는 규칙 (순수 함수)
├── onboarding.ts     첫 만남 질문·인사 흐름
├── tts.ts            스트리밍 TTS 어댑터와 고정 문장 캐시 (메모리 전용)
├── llm/              LLM 공급자 어댑터 (anthropic·openai·gemini·openai-compatible), SSE 파서, 페르소나
├── safety.ts         메시지·출력 안전 필터
├── google.ts         구글 ID 토큰 검증
├── auth.ts           비밀 로드, Bearer 토큰, 클라이언트 IP 판정
├── rate-limit.ts     기기·IP별 요청 한도
└── observe.ts        한 줄 JSON 로그와 오류 집계
```

프레임 정의와 검증기는 `shared/packages/protocol`(서브모듈 `companion-shared`)에 있습니다.

## API 개요

인증 헤더는 차량 토큰 또는 폰 토큰 `Authorization: Bearer <token>`입니다. 오류는 `{"error": "<code>"}` 형태로 돌려줍니다.

| 경로 | 설명 |
|---|---|
| `GET /healthz` | 상태 확인. 외부에는 `{"ok":true}`만 노출 |
| `POST /v1/cars/register` | 차량 등록, 차량 토큰 발급 (IP별 분당 한도) |
| `POST /v1/sessions` | 차량 토큰으로 일회용 WebSocket 티켓 발급 |
| `POST /v1/phone-sessions` | 폰 토큰으로 일회용 WebSocket 티켓 발급 |
| `DELETE /v1/phone-sessions/current` | 폰 로그아웃 (토큰 폐기) |
| `POST /v1/auth/google` | 구글 ID 토큰으로 로그인, 폰 토큰 발급 |
| `GET /v1/account` | 계정 정보 |
| `POST /v1/pairings` | 차: 연결 코드 발급 |
| `GET /v1/pairings/{code}` | 폰: 코드 상태 조회 |
| `POST /v1/pairings/{code}/claim` | 폰: 코드로 차와 연결 |
| `GET` · `DELETE /v1/pairings/current` | 차: 연결 상태 조회 / 차·폰: 연결 해제 |
| `GET` · `POST /v1/consents`, `DELETE /v1/consents/{type}` | 동의 조회·기록·철회 |
| `GET` · `DELETE /v1/memory`, `DELETE /v1/memory/{id}` | 기억 목록, 전체·항목 삭제 |
| `GET` · `PATCH /v1/settings` | 호칭·말투·수다 정도 등 설정 |
| `POST /v1/vehicle-events` | 차: 차량 이벤트 전달 |
| `POST /v1/friends/invites` | 친구 초대 코드 만들기 |
| `POST /v1/friends/invites/{code}/accept` | 초대 수락 |
| `GET /v1/friends`, `PATCH`·`DELETE /v1/friends/{id}` | 친구 목록, 도착 알림 설정, 끊기 |
| `POST` · `GET /v1/messages`, `POST /v1/messages/{id}/report` | 메시지 보내기·조회·신고 |
| `GET /v1/diary?date=YYYY-MM-DD` | 하루 일기와 요약 |
| `WS /v1/talk?ticket=…` | 대화 (차·폰 공통) |
| `WS /v1/inbox/stream?ticket=…` | 폰 푸시 수신 (친구 메시지, 여정 종료, 일기 완성) |

### /v1/talk

티켓은 한 번만, 60초 안에 쓸 수 있습니다. 텍스트 프레임은 JSON이고, 앱→서버 바이너리는 받지 않습니다(`1003`으로 닫음).

```
→ {"type":"hello","v":1,"appVersion":"1.0"}
→ {"type":"turn.start","turnId":"t1","trigger":"ptt"}
→ {"type":"text","turnId":"t1","text":"오늘 비 와서 천천히 갈게"}
→ {"type":"turn.end","turnId":"t1"}
← {"type":"reply.start","turnId":"t1","audio":{"format":"pcm_s16le","sampleRate":24000,"channels":1}}
← {"type":"reply.delta","turnId":"t1","text":"…"}      (여러 번)
← (바이너리: PCM s16le 24kHz mono 조각)                 (여러 번)
← {"type":"reply.end","turnId":"t1","text":"…","firstTokenMs":0,"totalMs":0}
```

`turn.cancel`을 보내면 그 턴의 프레임은 더 나가지 않습니다. 차량 상태는 `ctx` 프레임으로 보내며, 좌표 필드는 서버가 버립니다.

## 설정

값은 환경변수 또는 `~/.config/companion/server.env`(권한 600)에서 읽습니다. 변수 이름만 적은 예시는 `server.env.example`에 있습니다.

| 변수 | 설명 |
|---|---|
| `LLM_PROVIDER` / `LLM_MODEL` | LLM 공급자(`anthropic`·`openai`·`gemini`·`openai-compatible`)와 모델 |
| `LLM_BASE_URL` / `LLM_API_KEY` | OpenAI 호환 공급자의 주소와 키 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | 공급자별 키 |
| `BREEZE_API_KEY` | TTS 공급자 키. 비면 음성 없이 글자만 보냅니다 |
| `COMPANION_TTS_PROVIDER` | `breeze`(기본) · `fake`(시험용 가짜 PCM) · `off` |
| `COMPANION_TTS_PRIME` | `0`이면 시작할 때 고정 문장을 미리 합성하지 않습니다 |
| `BREEZE_VOICE_ID` / `ONBOARDING_VOICE_ID` / `COMPANION_VOICE_SAMPLE` | 캐릭터 목소리, 온보딩 목소리, 목소리 복제용 원본 파일 경로 |
| `GOOGLE_WEB_CLIENT_ID` | 구글 로그인용 웹 클라이언트 ID. 비면 `POST /v1/auth/google`이 503을 돌려줍니다 |
| `COMPANION_ALLOW_NONGOOGLE_CLAIM` / `COMPANION_ALLOW_PHONE_ONLY` | `1`이면 구글이 아닌 폰 토큰·폰 전용 계정을 허용. 시험 서버 전용, 운영은 비워 둡니다 |
| `COMPANION_TRUST_PROXY` | `1`이면 프록시가 넣은 `CF-Connecting-IP`/`X-Forwarded-For`를 클라이언트 IP로 믿습니다 |
| `COMPANION_HTTP_PER_MIN` · `COMPANION_UPGRADES_PER_MIN` · `COMPANION_TURNS_PER_MIN` · `COMPANION_TURNS_PER_DAY` | IP별 등록·세션 한도, IP별 업그레이드 한도, 연결별 분당 턴 한도, 서버 전체 하루 턴 한도 |
| `PASSENGER_WEB_URL` | 친구 초대 링크의 앞부분 (`${PASSENGER_WEB_URL}/f/{코드}`) |
| `PORT` · `HOST` | 수신 포트(기본 8787)와 바인드 주소 |
| `COMPANION_DATA_DIR` · `COMPANION_LOG_FILE` | SQLite 폴더(기본 `./data`), 로그 파일 경로 |

> [!WARNING]
> API 키와 비밀값은 저장소에 두지 않습니다. 600 권한 파일이나 환경변수로만 주입하세요.

## 로컬 실행

[Bun](https://bun.sh) 1.4.2가 필요합니다.

```sh
git clone --recurse-submodules https://github.com/teamhey-challenge/companion-server.git
cd companion-server
bun install

# 최소 설정: LLM 키(없으면 대화 없이 서버만 뜹니다)
export COMPANION_TTS_PROVIDER=fake   # 외부 TTS 없이 시험

bun run start                        # = bun src/index.ts, 기본 포트 8787
```

실제 LLM으로 한 턴을 확인하려면 키를 설정한 뒤 `bun run scripts/smoke.ts "오늘 비 와서 천천히 갈게"`를 실행하세요. 첫 토큰 시간과 총 시간, 모델을 출력합니다.

## 테스트

```sh
bun run check      # 단위 시험 + 타입 검사 (외부 키 불필요)
bun test ./test    # 시험만
bun run typecheck  # tsc만
```

시험은 가짜 LLM·TTS·시계를 쓰므로 네트워크 없이 돕니다. 안전 필터와 답변 품질 평가 자료는 `test/fixtures/`에 있습니다.

## 배포

저장소에 Dockerfile은 없습니다. 서버는 단일 Bun 프로세스이므로 `bun src/index.ts`를 서비스로 띄우고, 앞단에 TLS와 WebSocket 업그레이드를 지원하는 리버스 프록시를 두면 됩니다. 프록시 뒤에서는 `COMPANION_TRUST_PROXY=1`을 켜고, 데이터 폴더(`COMPANION_DATA_DIR`)는 영속 볼륨에 두세요. `main`에 병합할 때마다 CI가 `bun run check`를 실행합니다.

## 개인정보

수집·보관·삭제 방식은 [개인정보 처리방침](https://hey.lastmile.ltd/privacy)을 참고하세요.

## 라이선스

MIT ([LICENSE](LICENSE)). 외부 서비스·라이브러리 고지는 [THIRD_PARTY.md](THIRD_PARTY.md)에 있습니다.
