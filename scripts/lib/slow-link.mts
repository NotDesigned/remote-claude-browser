// A slow, jittery link between an in-process gateway and its viewers, for the input smokes.
//
// Each frame in each direction is held for RTT/2 ± jitter, never overtaking an earlier one (a
// WebSocket is ordered), and now and then the whole direction stalls for 200–600 ms, as a phone's
// link does (head-of-line blocking). With everything 0 (the default), frames pass at once, as
// without it.
//
//   SMOKE_RTT_MS      round trip added, split evenly between the directions
//   SMOKE_JITTER_MS   ± this much on each frame's one-way delay
//   SMOKE_STALL_RATE  chance per frame of a 200–600 ms stall

export interface SlowLinkConfig {
  rttMs: number;
  jitterMs: number;
  stallRate: number;
}

export function slowLinkConfig(env: Record<string, string | undefined> = process.env) {
  const number = (name: string) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number >= 0`);
    return value;
  };
  return {
    rttMs: number("SMOKE_RTT_MS"),
    jitterMs: number("SMOKE_JITTER_MS"),
    stallRate: number("SMOKE_STALL_RATE"),
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
  const passThrough = config.rttMs === 0 && config.jitterMs === 0 && config.stallRate === 0;
  const flush = () => {
    timer = null;
    while (queue.length > 0 && queue[0]!.at <= performance.now()) queue.shift()!.deliver();
    if (queue.length > 0) timer = setTimeout(flush, Math.max(0, queue[0]!.at - performance.now()));
  };
  return {
    pass(deliver: () => void) {
      if (passThrough) return deliver();
      const oneWay = config.rttMs / 2 + (random() * 2 - 1) * config.jitterMs;
      const stall = random() < config.stallRate ? 200 + random() * 400 : 0;
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
  return config.rttMs === 0 && config.jitterMs === 0 && config.stallRate === 0
    ? "direct link"
    : `RTT ${config.rttMs} ms ±${config.jitterMs} ms, ${config.stallRate * 100}% stalls`;
}
