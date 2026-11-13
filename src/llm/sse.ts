/** 바이트 스트림에서 SSE `data:` 페이로드를 순서대로 내보낸다. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  const flush = function* (block: string) {
    const lines = block.split("\n").filter((l) => l.startsWith("data:"));
    if (lines.length) yield lines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
  };
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      yield* flush(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield* flush(buf);
}
