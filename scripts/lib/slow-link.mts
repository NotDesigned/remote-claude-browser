// A slow, jittery link between an in-process gateway and its viewers, for the input smokes.
//
// Each frame in each direction is held for RTT/2 ± jitter, never overtaking an earlier one (a
// WebSocket is ordered), and now and then the whole direction stalls for 200–600 ms, as a phone's
// link does (head-of-line blocking). With everything 0 (the default), frames pass at once, as
// without it.
//
//   SMOKE_RTT_MS      round trip added, split evenly between the directions
//   SMOKE_JITTER_MS   ± this much on each frame's one-way delay (RTT/5 when SMOKE_LOSS_RATE is
//                     set and this is not)
//   SMOKE_STALL_RATE  chance per frame of a 200–600 ms stall
//   SMOKE_LOSS_RATE   chance per frame that a packet of it is lost. TCP delivers in order, so a
//                     loss is not a missing frame but a head-of-line stall of its direction until
//                     the retransmission, one RTO of max(200 ms, 2 RTT) plus jitter later.

export interface SlowLinkConfig {
  rttMs: number;
  jitterMs: number;
  stallRate: number;
  lossRate: number;
}

export function slowLinkConfig(env: Record<string, string | undefined> = process.env) {
  const number = (name: string) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number >= 0`);
    return value;
  };
  const rttMs = number("SMOKE_RTT_MS");
  const lossRate = number("SMOKE_LOSS_RATE");
  if (lossRate > 1) throw new Error("SMOKE_LOSS_RATE must be at most 1");
  const jitterSet = env.SMOKE_JITTER_MS !== undefined && env.SMOKE_JITTER_MS !== "";
  return {
    rttMs,
    jitterMs: jitterSet || lossRate === 0 ? number("SMOKE_JITTER_MS") : rttMs / 5,
    stallRate: number("SMOKE_STALL_RATE"),
    lossRate,
  } satisfies SlowLinkConfig;
}

/**
 * One direction: frames come out in order, each no sooner than its own delay. One queue and one
 * timer, so that frames due at the same moment cannot change places (separate timers can), on the
 * monotonic clock (the wall clock can step).
 */
function lane(config: SlowLinkConfig, random: () => number) {
  let last = 0;
  const queue: Array<{ at: number; deliver: () => void }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const passThrough =
    config.rttMs === 0 &&
    config.jitterMs === 0 &&
    config.stallRate === 0 &&
    (config.lossRate ?? 0) === 0;
  /** A lost packet is resent after one retransmission timeout. */
  const rto = Math.max(200, 2 * config.rttMs);
  const flush = () => {
    timer = null;
    while (queue.length > 0 && queue[0]!.at <= performance.now()) queue.shift()!.deliver();
    if (queue.length > 0) timer = setTimeout(flush, Math.max(0, queue[0]!.at - performance.now()));
  };
  return {
    pass(deliver: () => void) {
      if (passThrough) return deliver();
      const oneWay = config.rttMs / 2 + (random() * 2 - 1) * config.jitterMs;
      let stall = random() < config.stallRate ? 200 + random() * 400 : 0;
      if (random() < (config.lossRate ?? 0)) stall += rto + random() * config.jitterMs;
      const now = performance.now();
      last = Math.max(last, now + Math.max(0, oneWay) + stall);
      queue.push({ at: last, deliver });
      if (timer === null) timer = setTimeout(flush, Math.max(0, queue[0]!.at - now));
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.length = 0;
    },
  };
}

export interface SlowSocket {
  send(data: string): void;
  onMessage(listener: (raw: string) => void): void;
  /** Frames still on their way are dropped. */
  close(): void;
}

/** The gateway's end of one viewer connection, through the slow link. */
export function slowSocket(
  socket: {
    readyState: number;
    send(data: string): void;
    on(event: "message", listener: (raw: unknown) => void): void;
  },
  config: SlowLinkConfig = slowLinkConfig(),
  random: () => number = Math.random,
): SlowSocket {
  const down = lane(config, random);
  const up = lane(config, random);
  const listeners: Array<(raw: string) => void> = [];
  socket.on("message", (raw) => {
    const text = String(raw);
    up.pass(() => {
      for (const listener of listeners) listener(text);
    });
  });
  return {
    send(data) {
      down.pass(() => {
        if (socket.readyState === 1) socket.send(data);
      });
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    close() {
      down.stop();
      up.stop();
    },
  };
}

export function describeLink(config: SlowLinkConfig): string {
  const loss = config.lossRate ?? 0;
  return config.rttMs === 0 && config.jitterMs === 0 && config.stallRate === 0 && loss === 0
    ? "direct link"
    : `RTT ${config.rttMs} ms ±${config.jitterMs} ms, ${config.stallRate * 100}% stalls` +
        (loss > 0 ? `, ${Number((loss * 100).toFixed(2))}% loss` : "");
}
