export interface TurnContext {
  /** 차량 상태 등 위치 외 문맥. 위치 필드는 서버가 거부한다. */
  [k: string]: string | number | boolean | null | undefined;
}

export interface LlmRequest {
  model: string;
  system: string;
  userText: string;
  maxTokens: number;
  /** openai-compatible 전용: 게이트웨이 기본 주소(예: http://127.0.0.1:20128/v1) */
  baseUrl?: string;
}

export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface LlmProvider {
  readonly name: "anthropic" | "openai" | "gemini" | "openai-compatible";
  buildRequest(req: LlmRequest, apiKey: string): HttpRequestSpec;
  /** SSE data 페이로드(JSON 문자열) 하나에서 텍스트 델타를 뽑는다. 없으면 null. */
  parseEvent(data: string): string | null;
  /** 선택: 게이트웨이가 실제로 고른 모델 이름(스트림 청크의 model 필드). */
  parseModel?(data: string): string | null;
}
