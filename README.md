# companion-server

차량 캐릭터 AI 컴패니언 "헤이리"(앱 Hey, 팀 Team Hey. 저장소 이름 `companion-*`은 그대로)의 서버 저장소다. HEY 시절 `hey-relay@3939310`에서 재사용할 뼈대만 복사했다(원본 저장소는 그대로 보관).

> 공모전 제출 묶음의 일부다. 앱 Hey(캐릭터 헤이리), 팀 Team Hey. 앱(APK)은 차량 앱·폰 앱 저장소의 `apk/`에 있다.

- 실행: Bun + TypeScript. `bun src/index.ts`(설정은 "설정" 표, 비밀은 600 권한 파일 `~/.config/companion/server.env`).
- 테스트 환경: `bun run check`(단위 시험 + tsc)는 외부 키 없이 돈다. 실제 LLM·TTS 호출은 키가 있는 환경에서만 `scripts/smoke.ts`로 확인한다. 운영 서버는 팀이 운영하는 `https://hey.lastmile.ltd/api`다.

음성 인식(STT)은 차량의 Pleos 내장 서비스가 맡아 서버는 마이크 오디오를 받지 않는다. 서버는 대화 텍스트를 받아 LLM을 부르고, 답을 글자와 TTS 오디오(PCM)로 돌려준다. 기본 LLM은 OmniRoute(OpenAI 호환) `chat-fast`다.

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
| `PASSENGER_WEB_URL` | `https://hey.lastmile.ltd` | 친구 초대 링크의 앞부분. 링크는 `${PASSENGER_WEB_URL}/f/{코드}` |

`/healthz`는 인증 없이 열려 있고 공개 요청에는 `{"ok":true}`만 돌려준다. provider·model·오류 집계는 프록시 헤더 없는 루프백 요청에만 나온다.

## 친구·메시지·일기 (D-47)

계정은 차의 `install_id`(폰이 페어링되어 있으면 같은 계정)이고, 차 없는 친구는 `POST /v1/phones/register {displayName}`로 폰 전용 계정(`ph_…`)과 폰 토큰을 받는다(IP별 분당 한도, 동의는 별도 `POST /v1/consents`). 폰은 `POST /v1/phone-sessions`로 소켓마다 한 번 쓰는 티켓을 받아 `/v1/talk`(차와 같은 프레임)와 `/v1/inbox/stream`(서버→폰 푸시만)에 연결한다.

| 경로 | 내용 |
|---|---|
| `POST /v1/friends/invites` | `{code,url,expiresAt}`, 6자 코드 24시간(여러 명이 쓸 수 있다) |
| `POST /v1/friends/invites/{code}/accept` | 서로 친구, `{friend}`. 자기 코드 400, 모르는 코드 404, 만료 410 |
| `GET /v1/friends` · `DELETE /v1/friends/{id}` · `PATCH /v1/friends/{id} {shareArrival}` | 목록(배열), 끊기(양쪽 삭제), 도착 알리기(기본 꺼짐) |
| `POST /v1/messages {toFriendId,text}` | 120자 이하, 안전 필터(욕설·링크·위험·자해·성적·혐오). 걸리면 `422 {error:"message_blocked",code:"message_blocked"}` |
| `GET /v1/messages?since=` | `{messages:[{id,direction:"in"\|"out",friendId,friendName,text,at}]}` 최신순, 신고된 것 제외 |
| `POST /v1/messages/{id}/report` | 받은 사람만, 204. 메시지는 숨겨지고 `message_reports`에 남는다 |
| `GET /v1/diary?date=` | `{date,entries:[{at,text,kind}],summary}`. kind: `trip_start`·`trip_done`·`friend_message`·`charging` |

푸시: 차 소켓은 `friend_message`/`friend_arrived` JSON 뒤에 `reply.start`·PCM·`reply.end`(turnId = 프레임 id)로 헤이리 목소리를 받는다(TTS 없으면 `audio:"none"`). 폰 받은편지함은 `friend_message`·`friend_arrived`·`trip_done`·`diary_ready`를 받는다. 못 읽어 준 메시지는 차가 연결될 때 최근 5개를 읽어 준다.

말로 전하기: "○○한테 … 전해 줘"(이름이 겹치면 되묻고 다음 답으로 보낸다), 방금 온 메시지(10분 안)에는 "고맙다고 전해 줘"처럼 이름 없이. 보낸 뒤 "○○한테 전했어!"로 확인한다.

운전 끝: ctx `gear:"P"` + `driverDoorOpen`(또는 `doorOpen`)이 새로 열림, 못 보면 P 60초. 이때 폰에 `trip_done`을 보내고 그날 일기를 LLM(헤이리 목소리, 3~5문장, 목적지 이름만·좌표 없음)으로 쓰면 `diary_ready`. 도착 알림은 ctx `arrived:true`(없으면 운전 끝)에서 `shareArrival`을 켠 친구에게만, 장소는 ctx `destinationName`(좌표처럼 보이면 버림).

## 온보딩·가족 (D-48)

`/v1/talk` 위의 온보딩 프레임(hello·동의 필요, 주행 중에도 막지 않는다): 앱→서버 `{"type":"onboarding","step":"whale_intro|q1|q2|q3|greeting"}`는 그 단계를 지금 말하라는 뜻이고, 서버는 `{"type":"onboarding","step","id","text"?}` 뒤에 `reply.start`·PCM·`reply.end`(turnId = id)를 보낸다. 고래 단계(`whale_intro`·`q1`~`q3`)는 고정 대사를 고래 목소리로, `greeting`은 헤이리 목소리로 q1~q3 답을 녹여 LLM이 쓴다(LLM 키가 없거나 실패하면 고정 인사). 답은 앱→서버 `{"type":"onboarding.answer","step":"q1|q2|q3","text":"<STT 문장>"}`, 응답 `{"type":"onboarding.ack","step","ok","name"?}`. `ok:false`(안전 필터·알아듣지 못함)면 다시 묻는다. q1은 `nickname`·`displayName`(settings 프레임 푸시), q2·q3는 운전자의 기억(기억 동의가 있을 때)이 된다. 온보딩을 하면 헤이리의 어투·호칭 첫 만남(F2)은 끝난 것으로 본다.

고래 목소리: `ONBOARDING_VOICE_ID`(환경변수 또는 `~/.config/companion/server.env`). 없으면 헤이리 목소리로 대신하고 시작할 때 `tts.whale_voice_fallback`을 한 번 로그한다. 값은 로그·저장소에 남기지 않는다.

가족(D-38·D-48): 운전자가 "우리 딸이야, 이름은 ○○"라고 소개하면 이름·관계만 운전자의 기억으로 남기고(기억 추출 지시), 소개받은 사람이 한 말은 기억하지 않는다. 헤이리는 기억에 가족 이름이 있으면 여럿이 탔을 때 이름을 번갈아 부른다(페르소나). 알림은 친구 메시지와 운전 끝 일기(`trip_done`·`diary_ready`)에서만 나간다.

## 점검

```sh
git clone --recurse-submodules git@github.com:darren-pleos-challenge/companion-server.git
bun install
bun run check   # 단위 시험 + tsc
bun run scripts/smoke.ts "오늘 비 와서 천천히 갈게"   # 실제 LLM 한 턴
```

`shared/`는 `companion-shared` 서브모듈이다. 비밀값(API 키)은 저장소에 두지 않고 `~/.config/companion/`의 600 파일로만 읽는다.

## 링크·라이선스

| 저장소 | 내용 |
|---|---|
| [companion-car](https://github.com/darren-pleos-challenge/companion-car) | 차량 앱 |
| [companion-phone](https://github.com/darren-pleos-challenge/companion-phone) | 폰 앱(QR 연결·동의·기억 관리) |
| [companion-server](https://github.com/darren-pleos-challenge/companion-server) | 대화·기억·TTS 서버(이 저장소) |
| [companion-web](https://github.com/darren-pleos-challenge/companion-web) | 폰 웹(폰 앱의 백업)·디자인 시스템 Storybook |
| [companion-shared](https://github.com/darren-pleos-challenge/companion-shared) | 디자인 토큰·프로토콜(서브모듈 `shared/`) |

- 코드는 MIT(`LICENSE`). 외부 서비스·라이브러리 고지는 `THIRD_PARTY.md`.
