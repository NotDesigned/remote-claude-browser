import { describe, expect, it } from "vitest";
import { createServerClock, DEFAULT_LIVE_BUFFER_MS } from "./clock";

describe("server clock live baseline", () => {
  it.each([-5_000, 8_000])(
    "keeps effective delay at the buffer with a viewer clock offset of %dms",
    (viewerOffset) => {
      let serverNow = 100_000;
      const oneWayMs = 20;
      const localNow = () => serverNow + viewerOffset;
      const clock = createServerClock({
        now: localNow,
        bufferMs: 180,
      });

      clock.observeRtt(oneWayMs * 2);
      // The gateway stamped this before the simulated one-way network trip.
      clock.observeServerTime(serverNow - oneWayMs, localNow());

      expect(clock.estimatedServerNow()).toBe(serverNow);
      expect(clock.estimatedServerNow() - clock.liveBaseline()).toBe(180);
    },
  );

  it("keeps the replay just behind the page whatever the round trip", () => {
    const clock = createServerClock({ now: () => 10_000 });
    expect(clock.liveBufferMs()).toBe(DEFAULT_LIVE_BUFFER_MS);
    clock.observeRtt(173);
    expect(clock.liveBufferMs()).toBe(DEFAULT_LIVE_BUFFER_MS);
  });
});
