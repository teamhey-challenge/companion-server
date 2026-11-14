/**
 * 첫 토큰 헤징: 첫 토큰이 afterMs 안에 안 오면(또는 첫 다리가 첫 토큰 전에 실패하면) 같은 요청을 한 번 더 보내고,
 * 먼저 첫 토큰을 준 쪽을 쓴다. 진 쪽은 즉시 끊는다. 게이트웨이 뒤 모델이 가끔 4~9초 걸리는 꼬리를 자르려는 것이고,
 * 느릴 때만 요청이 두 번 나간다. 두 다리 모두 첫 토큰 전에 실패해야 던진다.
 */
export interface HedgeLeg {
  signal: AbortSignal;
  /** 이 다리가 응답에서 읽은 실제 모델 이름을 여기에 채운다. */
  meta: { model?: string };
}

type Pull = { leg: Leg; r: IteratorResult<string> } | { leg: Leg; error: unknown };

interface Leg {
  ctl: AbortController;
  it: AsyncGenerator<string>;
  meta: { model?: string };
  pending: Promise<Pull> | null;
}

export async function* hedged(
  attempt: (leg: HedgeLeg) => AsyncGenerator<string>,
  afterMs: number,
  signal: AbortSignal,
  meta?: { model?: string },
): AsyncGenerator<string> {
  const legs: Leg[] = [];
  const abortAll = () => legs.forEach((l) => l.ctl.abort());
  signal.addEventListener("abort", abortAll, { once: true });

  const pull = (leg: Leg) => {
    leg.pending = leg.it.next().then(
      (r): Pull => ({ leg, r }),
      (error): Pull => ({ leg, error }),
    );
  };
  const launch = () => {
    const ctl = new AbortController();
    const legMeta: { model?: string } = {};
    const leg: Leg = { ctl, it: attempt({ signal: ctl.signal, meta: legMeta }), meta: legMeta, pending: null };
    legs.push(leg);
    pull(leg);
  };

  const timer = Promise.withResolvers<"hedge">();
  const handle = setTimeout(() => timer.resolve("hedge"), afterMs);
  try {
    launch();
    let hedgeLaunched = false;
    let firstError: unknown;
    const hedge = () => {
      if (hedgeLaunched || signal.aborted) return;
      hedgeLaunched = true;
      launch();
    };
    let winner: Leg | undefined;
    let first = "";
    while (!winner) {
      const live = legs.flatMap((l) => (l.pending ? [l.pending] : []));
      if (!live.length) throw firstError ?? new Error("llm: empty response");
      const got = await Promise.race<Pull | "hedge">(hedgeLaunched ? live : [...live, timer.promise]);
      if (got === "hedge") {
        hedge();
        continue;
      }
      got.leg.pending = null;
      if ("error" in got) {
        firstError ??= got.error;
        hedge();
        continue;
      }
      if (got.r.done) continue;
      winner = got.leg;
      first = got.r.value;
    }
    for (const l of legs) if (l !== winner) l.ctl.abort();
    if (meta) meta.model = winner.meta.model;
    yield first;
    for (;;) {
      const r = await winner.it.next();
      if (meta && !meta.model) meta.model = winner.meta.model;
      if (r.done) return;
      yield r.value;
    }
  } finally {
    clearTimeout(handle);
    signal.removeEventListener("abort", abortAll);
    abortAll();
  }
}
