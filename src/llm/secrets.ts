import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export function secretsPath(): string {
  return process.env.COMPANION_SECRETS_FILE ?? `${homedir()}/.config/companion/server.env`;
}

/** 600 권한 파일에서만 키를 읽는다. 파일이 없으면 빈 맵. 값은 절대 로그에 남기지 않는다. */
export function loadSecrets(path = secretsPath()): Record<string, string> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return {};
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`${path}: 권한이 600이 아님 (chmod 600 필요)`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (v) out[m[1]] = v;
  }
  return out;
}
