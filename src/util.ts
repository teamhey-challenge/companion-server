import { createHash, randomBytes } from "node:crypto";

/** 128비트 이상 무작위 토큰 (base64url, 22자) */
export function newToken(): string {
  return randomBytes(16).toString("base64url");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 로그에는 토큰 대신 이 짧은 해시만 남긴다 */
export function shortId(token: string): string {
  return hashToken(token).slice(0, 6);
}

/** 요청 단위 오류: 클라이언트에게 코드와 HTTP 상태로 돌려준다. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
